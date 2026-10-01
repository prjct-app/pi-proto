import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDaemon, daemonStatus, stopDaemon } from '../src/daemon/lifecycle.ts';
import { STARTER_TOKENS } from '../src/spec/tokens.ts';

type Event = { event: string; data: any };

const listen = (url: string): { events: Event[]; until: (name: string, test?: (data: any) => boolean, ms?: number) => Promise<Event>; stop: () => void } => {
  const events: Event[] = [];
  const controller = new AbortController();
  void (async () => {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
        const data = /^data: (.+)$/m.exec(block)?.[1];
        events.push({ event, data: data ? JSON.parse(data) : undefined });
      }
    }
  })().catch(() => undefined);
  const until = async (name: string, test: (data: any) => boolean = () => true, ms = 20_000): Promise<Event> => {
    const end = Date.now() + ms;
    for (;;) {
      const found = events.find(e => e.event === name && test(e.data));
      if (found) return found;
      if (Date.now() > end) throw new Error(`no "${name}" event; saw ${events.map(e => e.event).join(', ')}`);
      await new Promise(r => setTimeout(r, 40));
    }
  };
  return { events, until, stop: () => controller.abort() };
};

const post = async (url: string, body: unknown): Promise<any> => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

test('the daemon serves the storybook, applies one-node changes live, routes the composer to Pi, and speaks MCP', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-proto-daemon-'));
  const project = mkdtempSync(join(tmpdir(), 'pi-proto-daemon-project-'));
  writeFileSync(join(project, 'package.json'), '{"name":"shop"}');
  const viewer = join(home, 'viewer');
  mkdirSync(viewer, { recursive: true });
  writeFileSync(join(viewer, 'index.html'), '<!doctype html><div id="root"></div><script src="app.js"></script>');
  const saved = { ...process.env };
  process.env['PI_PROTO_HOME'] = home;
  process.env['PI_PROTO_VIEWER'] = viewer;
  process.env['PI_PROTO_DAEMON_PORT'] = String(52_000 + Math.floor(Math.random() * 800));
  process.env['PI_PROTO_OFFLINE'] = '1';
  const streams: Array<{ stop: () => void }> = [];
  try {
    const alive = await ensureDaemon(home);
    assert.equal((await ensureDaemon(home)).pid, alive.pid, 'a running daemon is reused');
    assert.equal((await daemonStatus(home)).running, true);

    // A workspace for the project, and its storybook.
    const init = await post(`${alive.url}/api/init`, { location: project, artifact: 'prototype' });
    assert.match(init.body.url, /\/p_[a-f0-9]+\/$/);
    const base = init.body.url as string;
    writeFileSync(join(home, init.body.projectId, 'proto', 'guide', 'tokens.yaml'), STARTER_TOKENS);
    assert.match(await (await fetch(base)).text(), /app\.js/);
    const story = await (await fetch(`${base}api/story`)).json() as any;
    assert.equal(story.protocol, 4);
    assert.deepEqual(story.prototypes.map((p: any) => p.id), ['inicio']);
    assert.ok(story.guides.some((g: any) => g.slug === '90-sitemap'), 'the sitemap documents itself');
    assert.ok(story.guides.some((g: any) => g.slug === '10-tokens'));
    assert.match(await (await fetch(`${base}p/inicio.html`)).text(), /data-node="titulo"/);
    assert.match(await (await fetch(`${base}g/10-tokens`)).text(), /bg-brand/);

    // Changing one node sends only that node's new HTML.
    const page = listen(`${base}__events`);
    streams.push(page);
    await page.until('hello');
    const edit = await post(`${base}api/ops`, { prototype: 'inicio', did: 'título', ops: [{ op: 'set', id: 'titulo', fields: { text: 'Hola mundo' } }] });
    assert.equal(edit.body.version, 2);
    const patch = await page.until('patch');
    assert.deepEqual(patch.data.patches.map((p: any) => p.id), ['titulo']);
    assert.match(patch.data.patches[0].html, /^<h1 id="titulo" data-node="titulo"[^>]*>Hola mundo<\/h1>$/);
    // A new page is structure: the prototype reloads, the history says who did what.
    const created = await post(`${base}api/create_page`, { prototype: 'inicio', title: 'Pago', flow: 'Compra' });
    assert.equal(created.body.page, 'pago');
    await page.until('prototype', d => d.prototype === 'inicio' && d.version === 3);
    const history = await (await fetch(`${base}api/history?id=inicio`)).json() as any[];
    assert.deepEqual(history.map(h => h.did), ['nueva página Pago', 'título', 'crear el prototipo']);
    const reverted = await post(`${base}api/revert`, { prototype: 'inicio', version: 1 });
    assert.equal(reverted.body.version, 4);

    // Without a Pi session the composer says so; with one, the message reaches it.
    const nobody = await post(`${base}__ask`, { text: 'hola' });
    assert.equal(nobody.status, 409);
    const pi = listen(`${base}__session?id=s1&label=Pi%20test`);
    streams.push(pi);
    await pi.until('hello');
    await page.until('session', d => d?.label === 'Pi test');
    await post(`${base}api/viewing`, { prototype: 'inicio', page: 'inicio', node: 'titulo' });
    assert.equal((await post(`${base}__ask`, { text: 'más grande', images: [] })).status, 202);
    const asked = await pi.until('ask');
    assert.equal(asked.data.text, 'más grande');
    assert.equal(asked.data.viewing.node, 'titulo', 'the agent learns what the person was looking at');
    assert.equal((await post(`${base}__pi`, { model: { provider: 'x', id: 'y' } })).status, 202);
    assert.deepEqual((await pi.until('pi-change')).data.model, { provider: 'x', id: 'y' });
    await post(`${base}__session/report`, { id: 's1', agent: { state: 'working', step: 'Editando inicio.yaml', startedAt: 1 }, pi: { models: [], thinking: 'high', levels: [] } });
    assert.equal((await page.until('agent')).data.step, 'Editando inicio.yaml');
    await post(`${base}__session/report`, { id: 's1', reply: 'Listo.' });
    assert.equal((await page.until('reply')).data.text, 'Listo.');

    // MCP: the same operations for any agent, and the storybook as an MCP App.
    const rpc = async (method: string, params: unknown = {}) => (await post(`${alive.url}/mcp`, { jsonrpc: '2.0', id: 1, method, params })).body;
    assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'pi-proto');
    const tools = (await rpc('tools/list')).result.tools;
    assert.ok(tools.find((t: any) => t.name === 'proto_sitemap')._meta.ui.resourceUri === 'ui://pi-proto/storybook');
    const read = await rpc('tools/call', { name: 'proto_read', arguments: { project, prototype: 'inicio' } });
    assert.match(read.result.content[0].text, /id: titulo/);
    assert.doesNotMatch(read.result.content[0].text, /history/);
    const bad = await rpc('tools/call', { name: 'proto_edit', arguments: { project, prototype: 'inicio', did: 'x', ops: [{ op: 'remove', id: 'nope' }] } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /no node "nope"/);

    // Tokens/document requests are not implicit prototype requests (HTTP + MCP).
    const artifactProject = join(project, 'tokens-only');
    mkdirSync(artifactProject);
    const artifact = await post(`${alive.url}/api/init`, { location: artifactProject, artifact: 'tokens' });
    const artifactBase = artifact.body.url as string;
    assert.deepEqual((await (await fetch(`${artifactBase}api/story`)).json() as any).prototypes, []);
    const tokenWrite = await rpc('tools/call', { name: 'proto_tokens', arguments: { project: artifactProject, tokens: { colors: { brand: '#eb5600' } } } });
    assert.equal(tokenWrite.result.isError, undefined);
    assert.match(tokenWrite.result.content[0].text, /No prototypes changed/);
    const designWrite = await rpc('tools/call', { name: 'proto_design', arguments: { project: artifactProject, markdown: '# Diseño\n\nAlcance: documento. Retícula editorial y tinta cálida. Valores: guide/tokens.yaml.', references: [{ source: 'reference.png', role: 'target', notes: 'Marco editorial, no una tarjeta genérica.' }] } });
    assert.equal(designWrite.result.isError, undefined);
    assert.match(designWrite.result.content[0].text, /500 words/);
    const designRead = await rpc('tools/call', { name: 'proto_design', arguments: { project: artifactProject } });
    assert.match(designRead.result.content[0].text, /target.*reference.png/);
    assert.deepEqual((await (await fetch(`${artifactBase}api/story`)).json() as any).prototypes, []);
    const app = await rpc('resources/read', { uri: 'ui://pi-proto/storybook' });
    assert.equal(app.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  } finally {
    for (const s of streams) s.stop();
    await stopDaemon(home);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
