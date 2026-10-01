import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readJson, sendFile, withinRoot } from '../server/serve.ts';
import { guideDocument } from '../guide-page.ts';
import { readGuides } from '../story.ts';
import { readPrototype, toYaml } from '../spec/store.ts';
import { initWorkspace } from '../spec/init.ts';
import type { Op } from '../spec/schema.ts';
import { ProjectHub } from './hub.ts';
import { handleMcp } from './mcp.ts';
import { handleAsk } from './composer.ts';
import { connectJev, type Jev } from './understand.ts';
import { DAEMON_REVISION } from './lifecycle.ts';
import { readTokens } from '../spec/tokens.ts';
import { readDesign, writeDesign, writeTokens, type Reference } from '../design-guide.ts';

/**
 * The daemon's HTTP side. One port for every project:
 *
 *   /health                     alive check
 *   /mcp                        MCP (Streamable HTTP, JSON)
 *   /<p_id>/                    the storybook app (served from ~/.prjct/proto-viewer/dist)
 *   /<p_id>/p/<file>            rendered prototypes, main.css, runtime
 *   /<p_id>/g/<slug>            a guide page as a document
 *   /<p_id>/__events            live events for pages (SSE)
 *   /<p_id>/__session           live events for a Pi session (SSE), plus /report
 *   /<p_id>/__ask, /__pi        the composer: to the Pi session working on the project
 *   /<p_id>/api/…               the operations the storybook and Pi call
 */

type Json = Record<string, unknown>;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export type DaemonServer = Readonly<{ server: Server; port: number; url: string; hubs: Map<string, ProjectHub>; close(): Promise<void> }>;

export const startServer = async (options: { home: string; port: number; viewer: string; host?: string; jev?: Jev | null; understandTimeoutMs?: number }): Promise<DaemonServer> => {
  const host = options.host ?? '127.0.0.1';
  const hubs = new Map<string, ProjectHub>();
  const starting = new Map<string, Promise<ProjectHub | undefined>>();
  const origin = { value: '' };
  const classifier: { pending?: Promise<Jev | undefined>; client?: Jev } = {};
  const jev = async (): Promise<Jev | undefined> => {
    if (options.jev !== undefined) return options.jev ?? undefined;
    if (classifier.client) return classifier.client;
    classifier.pending ??= connectJev().then(client => { classifier.client = client; return client; })
      .finally(() => { classifier.pending = undefined; });
    return classifier.pending;
  };

  const hubFor = async (projectId: string): Promise<ProjectHub | undefined> => {
    if (!/^p_[a-f0-9]+$/.test(projectId)) return undefined;
    const existing = hubs.get(projectId);
    if (existing) return existing;
    const pending = starting.get(projectId);
    if (pending) return pending;
    const work = (async () => {
      const hub = new ProjectHub(options.home, projectId);
      if (!(await hub.start())) return undefined;
      hubs.set(projectId, hub);
      return hub;
    })().finally(() => starting.delete(projectId));
    starting.set(projectId, work);
    return work;
  };
  const mcpHubs = { hub: hubFor, home: options.home, get origin() { return origin.value; } };

  const api = async (hub: ProjectHub, op: string, req: IncomingMessage, url: URL): Promise<unknown> => {
    const body = req.method === 'POST' ? await readJson(req) as Json : {};
    const by = String(body['by'] ?? 'person');
    switch (op) {
      case 'story': return hub.story();
      case 'tokens': {
        if (body['tokens'] !== undefined) { await writeTokens(hub.protoDir, body['tokens']); await hub.refreshGuide(); return { updated: true }; }
        const tokens = await readTokens(hub.protoDir);
        const group = url.searchParams.get('group');
        if (group && !['colors', 'fonts', 'radius', 'spacing', 'text', 'components'].includes(group)) throw new Error('unknown token group');
        return group ? { [group]: tokens[group as keyof typeof tokens] ?? {} } : tokens;
      }
      case 'design': {
        if (body['markdown'] !== undefined) {
          await writeDesign(hub.protoDir, String(body['markdown']), body['references'] as Reference[]);
          await hub.refreshGuide(); return { updated: true };
        }
        return { markdown: await readDesign(hub.protoDir) };
      }
      case 'prototype': {
        const p = await readPrototype(hub.protoDir, String(url.searchParams.get('id')));
        return url.searchParams.get('format') === 'yaml' ? { yaml: toYaml(p, { history: false }) } : { ...p, history: undefined };
      }
      case 'history': return hub.history(String(url.searchParams.get('id')));
      case 'ops': {
        const applied = await hub.apply(String(body['prototype']), body['ops'] as Op[], { by, did: String(body['did'] ?? 'cambio') });
        return { version: applied.version };
      }
      case 'revert': return { version: (await hub.revert(String(body['prototype']), Number(body['version']), by)).version };
      case 'create_prototype': return hub.createPrototype(String(body['title']), body['group'] ? String(body['group']) : undefined, by);
      case 'create_page': return hub.createPage({ prototype: String(body['prototype']), title: String(body['title']), flow: body['flow'] ? String(body['flow']) : undefined, duplicateOf: body['duplicateOf'] ? String(body['duplicateOf']) : undefined, by });
      case 'go_to': hub.publish('navigate', { prototype: body['prototype'], page: body['page'], node: body['node'] }); return { ok: true };
      case 'viewing': hub.viewing = { ...(body as object), at: Date.now() } as never; return { ok: true };
      case 'write_guide': {
        const slug = String(body['slug'] ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        if (!slug) throw new Error('a guide page needs a name');
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(join(hub.protoDir, 'guide'), { recursive: true });
        await writeFile(join(hub.protoDir, 'guide', `${slug}.md`), String(body['markdown'] ?? ''), 'utf8');
        return { slug };
      }
      case 'guide': {
        const source = await hub.guideSource(String(url.searchParams.get('slug')));
        if (source === undefined) throw new Error('no such guide page');
        return { markdown: source };
      }
    }
    throw new Error(`unknown operation ${op}`);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname === '/health') { json(res, 200, { ok: true, pid: process.pid, revision: DAEMON_REVISION }); return; }
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
        const body = await readJson(req);
        const messages = Array.isArray(body) ? body : [body];
        const replies = (await Promise.all(messages.map(m => handleMcp(mcpHubs, m as Json)))).filter(Boolean);
        if (!replies.length) { res.writeHead(202).end(); return; }
        json(res, 200, Array.isArray(body) ? replies : replies[0]);
        return;
      }
      if (url.pathname === '/api/init' && req.method === 'POST') {
        const body = await readJson(req) as Json;
        const artifact = body['artifact'];
        if (artifact !== undefined && !['workspace', 'tokens', 'guide', 'prototype'].includes(String(artifact))) throw new Error('unknown init artifact');
        const { project, created } = await initWorkspace(String(body['location']), String(body['by'] ?? 'person'), { artifact: artifact as 'workspace' | 'tokens' | 'guide' | 'prototype' | undefined });
        json(res, 200, { projectId: project.projectId, url: `${origin.value}/${project.projectId}/`, created });
        return;
      }
      // Each project's storybook opens only by its own URL; the root lists none of them.
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('pi-proto'); return; }
      const [, projectId = '', ...rest] = url.pathname.split('/');
      const hub = await hubFor(projectId);
      if (!hub) { json(res, 404, { error: 'no design workspace for this project' }); return; }
      const sub = rest.join('/');
      if (!url.pathname.startsWith(`/${projectId}/`)) { res.writeHead(302, { location: `/${projectId}/` }).end(); return; }

      if (sub === '__events') { hub.bus.subscribe(req, res, 'story'); return; }
      if (sub === '__session') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: hello\ndata: {}\n\n`);
        hub.attach(String(url.searchParams.get('id')), String(url.searchParams.get('label') ?? 'Pi'), res);
        return;
      }
      if (sub === '__session/report' && req.method === 'POST') {
        const body = await readJson(req) as Json;
        json(res, hub.report(String(body['id']), body as never) ? 200 : 404, { ok: true });
        return;
      }
      if ((sub === '__ask' || sub === '__pi') && req.method === 'POST') {
        const body = await readJson(req) as Json;
        if (sub === '__ask') {
          const result = await handleAsk(hub, body, jev, options.understandTimeoutMs);
          json(res, result.status, result.body);
          return;
        }
        if (!hub.toSession('pi-change', body)) {
          json(res, 409, { error: 'Ninguna sesión de Pi trabaja en este proyecto. Abre Pi en la carpeta del proyecto.' });
          return;
        }
        json(res, 202, { ok: true });
        return;
      }
      if (sub === '__pi' && req.method === 'GET') { json(res, 200, hub.sessionSummary()?.pi ?? null); return; }
      if (sub.startsWith('api/')) {
        try { json(res, 200, await api(hub, sub.slice(4), req, url)); }
        catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      if (sub.startsWith('g/')) {
        const slug = decodeURIComponent(sub.slice(2));
        const page = (await readGuides(hub.protoDir)).find(g => g.slug === slug);
        const source = page && await hub.guideSource(slug);
        if (!page || source === undefined) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(guideDocument(source, page.title, '../p/main.css'));
        return;
      }
      if (sub.startsWith('p/')) {
        const file = withinRoot(join(hub.protoDir, 'dist'), decodeURIComponent(sub.slice(2)));
        if (!file) { res.writeHead(403).end(); return; }
        await sendFile(res, file);
        return;
      }
      const file = withinRoot(options.viewer, sub || 'index.html');
      if (!file) { res.writeHead(403).end(); return; }
      await sendFile(res, file);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  });

  await new Promise<void>((ok, fail) => server.once('error', fail).listen(options.port, host, () => ok()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  origin.value = `http://${host}:${port}`;
  return {
    server,
    port,
    url: origin.value,
    hubs,
    async close() {
      await Promise.allSettled(starting.values());
      for (const hub of hubs.values()) hub.stop();
      server.closeAllConnections?.();
      await new Promise<void>(ok => server.close(() => ok()));
    },
  };
};
