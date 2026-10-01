import YAML from 'yaml';
import { resolveProtoProject } from '../project.ts';
import { initWorkspace } from '../spec/init.ts';
import { readPrototype, toYaml } from '../spec/store.ts';
import type { Op } from '../spec/schema.ts';
import type { ProjectHub } from './hub.ts';
import { DESIGNER_PROMPT } from '../designer.ts';
import { readDesign, writeDesign, writeTokens, type Reference } from '../design-guide.ts';
import { readTokens } from '../spec/tokens.ts';
import { projectContext } from '../project-context.ts';
import { componentPath, memoryHomeFor, PROTO_COMPONENT_NAME } from '../identity.ts';
import { StatusFile } from '../status.ts';

/**
 * The daemon's MCP server (Streamable HTTP, JSON responses): the same
 * operations the storybook's buttons and Pi's tools use, for any agent. The
 * storybook itself is an MCP App: tools that show something point at the
 * ui://pi-proto/storybook resource, which hosts that support MCP Apps render.
 */

export const APP_URI = 'ui://pi-proto/storybook';
const APP_MIME = 'text/html;profile=mcp-app';

type Json = Record<string, unknown>;
type Hubs = { hub(projectId: string): Promise<ProjectHub | undefined>; origin: string; home?: string };

const PROJECT = { type: 'string', description: 'The project: its folder path, or its prjct id (p_…).' };
const PROTOTYPE = { type: 'string', description: 'Prototype id, as in the sitemap.' };

const OPS_HELP = 'Operations on ids, applied as one version: '
  + '{op:"set", id, fields:{text|class|as|src|alt|placeholder|hidden|on|title|flow…}} (null removes a field); '
  + '{op:"insert", parent, index?, node:{id?, type, class?, text?, children?, on?}}; {op:"remove", id}; {op:"move", id, parent, index?}; '
  + '{op:"add_page", page:{id, title, flow?, class?, children:[]}, index?}; {op:"remove_page", id}; '
  + '{op:"set_prototype", fields:{title|group|description|status}}. '
  + 'Node types: box, stack, row, grid, text, image, button, input, textarea, link, icon, divider, html. '
  + 'Clicks: on:{click:{go:"page"}} | {toggle:"node"} | {back:true}. Classes are Tailwind v4; guide/tokens.yaml defines shared tokens and components (btn-primary: {as: button, class: "bg-brand text-surface px-5 py-3"}). Reuse named classes for global restyling.';

type ToolDef = { name: string; description: string; ui?: boolean; inputSchema: Record<string, unknown> };

const TOOLS: ToolDef[] = [
  { name: 'proto_context', description: 'Bounded cached local design/library evidence; no workspace creation or build. Use caller memory_context for project decisions. frontend selects a package inside the project.', inputSchema: { type: 'object', properties: { project: PROJECT, frontend: { type: 'string' }, refresh: { type: 'boolean' } }, required: ['project'] } },
  { name: 'proto_open', description: 'Prepare a workspace, no prototype by default. artifact: prototype only if screens were requested.', ui: true, inputSchema: { type: 'object', properties: { project: PROJECT, artifact: { type: 'string', enum: ['workspace', 'tokens', 'guide', 'prototype'] } }, required: ['project'] } },
  { name: 'proto_tokens', description: 'Read token values (optional group), or merge tokens without changing prototypes. Stop after a tokens-only request.', inputSchema: { type: 'object', properties: { project: PROJECT, group: { type: 'string' }, tokens: { type: 'object' } }, required: ['project'] } },
  { name: 'proto_design', description: 'Read/write the single design specification (max 500 words incl. references). State scope, concrete visual decisions, states/responsive, requested navigation and pending decisions. References have source, role (target/current/constraint), notes. No copied tokens or inventories.', inputSchema: { type: 'object', properties: { project: PROJECT, markdown: { type: 'string', maxLength: 8000 }, references: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { source: { type: 'string' }, role: { type: 'string', enum: ['target', 'current', 'constraint'] }, notes: { type: 'string' } }, required: ['source', 'role', 'notes'] } } }, required: ['project'] } },
  { name: 'proto_sitemap', description: 'Compact index; supply prototype for its pages/flows/clicks. Not needed for tokens-only or document-only tasks.', ui: true, inputSchema: { type: 'object', properties: { project: PROJECT, prototype: PROTOTYPE }, required: ['project'] } },
  { name: 'proto_read', description: 'A prototype (or one page of it) as YAML with node ids, without its history. Read the relevant page when its current YAML was not already supplied.', inputSchema: { type: 'object', properties: { project: PROJECT, prototype: PROTOTYPE, page: { type: 'string' } }, required: ['project', 'prototype'] } },
  { name: 'proto_edit', description: `Change a prototype with small operations; the open storybook redraws only what changed. ${OPS_HELP}`, inputSchema: { type: 'object', properties: { project: PROJECT, prototype: PROTOTYPE, ops: { type: 'array', items: { type: 'object' } }, did: { type: 'string', description: 'What the change does, in a few words, for the history.' } }, required: ['project', 'prototype', 'ops', 'did'] } },
  { name: 'proto_create_prototype', description: 'Create a new prototype. Variants of the same thing share a group.', inputSchema: { type: 'object', properties: { project: PROJECT, title: { type: 'string' }, group: { type: 'string' } }, required: ['project', 'title'] } },
  { name: 'proto_create_page', description: 'Add a page to a prototype, blank or a copy of another page.', inputSchema: { type: 'object', properties: { project: PROJECT, prototype: PROTOTYPE, title: { type: 'string' }, flow: { type: 'string' }, duplicate_of: { type: 'string' } }, required: ['project', 'prototype', 'title'] } },
  { name: 'proto_history', description: 'The versions of a prototype, newest first.', inputSchema: { type: 'object', properties: { project: PROJECT, prototype: PROTOTYPE }, required: ['project', 'prototype'] } },
  { name: 'proto_revert', description: 'Go back to a version, as a new version: nothing is lost.', inputSchema: { type: 'object', properties: { project: PROJECT, prototype: PROTOTYPE, version: { type: 'integer' } }, required: ['project', 'prototype', 'version'] } },
  { name: 'proto_go_to', description: 'Show a prototype page (and highlight a node) in every open storybook.', ui: true, inputSchema: { type: 'object', properties: { project: PROJECT, prototype: PROTOTYPE, page: { type: 'string' }, node: { type: 'string' } }, required: ['project', 'prototype'] } },
  { name: 'proto_write_guide', description: 'Write supplementary evidence on demand, not duplicated specifications. The main specification must use proto_design (500 words).', inputSchema: { type: 'object', properties: { project: PROJECT, slug: { type: 'string' }, markdown: { type: 'string' } }, required: ['project', 'slug', 'markdown'] } },
];

const projectIdOf = async (project: unknown): Promise<string> => {
  if (typeof project !== 'string' || !project) throw new Error('project is required.');
  if (/^p_[a-f0-9]+$/.test(project)) return project;
  return (await resolveProtoProject(project)).projectId;
};

const text = (value: unknown): { content: Array<{ type: 'text'; text: string }> } =>
  ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

/** Run one tool; `url` in the result is where the storybook shows it, for the MCP App. */
export const callTool = async (hubs: Hubs, name: string, args: Json, by = 'agent'): Promise<Json> => {
  if (name === 'proto_context') {
    const target = String(args['project'] ?? '');
    if (!target) throw new Error('project is required');
    const protoDir = /^p_[a-f0-9]+$/.test(target) ? componentPath(hubs.home ?? memoryHomeFor(), 'project', target, PROTO_COMPONENT_NAME) : undefined;
    const config = protoDir ? await new StatusFile(protoDir).read() : undefined;
    if (protoDir && !config) throw new Error('No existing project location for this id; supply its folder path.');
    const p = await resolveProtoProject(config?.project.location ?? target);
    const result = await projectContext(protoDir ? { ...p, protoDir } : p, { frontend: typeof args['frontend'] === 'string' ? args['frontend'] : undefined, refresh: args['refresh'] === true });
    return text(`${result.text}\nProject memory belongs to the caller: use its memory_context if available; no memory was retrieved by this daemon.`);
  }
  if (['proto_open', 'proto_tokens', 'proto_design'].includes(name) && typeof args['project'] === 'string' && !/^p_/.test(args['project'])) {
    const artifact = args['artifact'];
    if (artifact !== undefined && !['workspace', 'tokens', 'guide', 'prototype'].includes(String(artifact))) throw new Error('unknown init artifact');
    await initWorkspace(args['project'], by, { artifact: artifact as 'workspace' | 'tokens' | 'guide' | 'prototype' | undefined });
  }
  const projectId = await projectIdOf(args['project']);
  const hub = await hubs.hub(projectId);
  if (!hub) throw new Error(`project ${projectId} has no design workspace; call proto_open with its folder path.`);
  const url = `${hubs.origin}/${projectId}/`;
  const prototype = String(args['prototype'] ?? '');
  switch (name) {
    case 'proto_open': return { ...text(`Prototype: ${url}`), structuredContent: { url } };
    case 'proto_tokens': {
      if (args['tokens'] !== undefined) { await writeTokens(hub.protoDir, args['tokens']); await hub.refreshGuide(); return text('Updated guide/tokens.yaml. No prototypes changed.'); }
      const tokens = await readTokens(hub.protoDir);
      const group = args['group'];
      if (group !== undefined && !['colors', 'fonts', 'radius', 'spacing', 'text', 'components'].includes(String(group))) throw new Error('unknown token group');
      const yaml = YAML.stringify(group ? { [String(group)]: tokens[group as keyof typeof tokens] ?? {} } : tokens);
      return text(yaml.length > 12_000 ? 'Read a single token group; full set exceeds context budget.' : yaml);
    }
    case 'proto_design': {
      if (args['markdown'] !== undefined) { await writeDesign(hub.protoDir, String(args['markdown']), args['references'] as Reference[]); await hub.refreshGuide(); return text('Saved guide/00-design.md (≤500 words). No prototypes changed.'); }
      return text(await readDesign(hub.protoDir) ?? 'No authored specification. Read references before writing a design direction; Entrega is only an index.');
    }
    case 'proto_sitemap': {
      const story = await hub.story() as { prototypes: Array<{ id: string; title: string; version: number; status: string; pages: unknown[]; flows: unknown[]; interactions: unknown[] }>; problems: string[] };
      const prototypes = story.prototypes.filter(p => !prototype || p.id === prototype).map(p => prototype
        ? { id: p.id, version: p.version, pages: p.pages, flows: p.flows, interactions: p.interactions }
        : { id: p.id, title: p.title, version: p.version, status: p.status, pages: p.pages.length });
      return { ...text({ prototypes, problems: story.problems }), structuredContent: { url } };
    }
    case 'proto_read': {
      const p = await readPrototype(hub.protoDir, prototype);
      const page = args['page'] ? p.pages.find(x => x.id === args['page']) : undefined;
      if (args['page'] && !page) throw new Error(`no page "${String(args['page'])}".`);
      return text(page ? YAML.stringify(page, { lineWidth: 0 }) : toYaml(p, { history: false }));
    }
    case 'proto_edit': {
      const applied = await hub.apply(prototype, args['ops'] as Op[], { by, did: String(args['did'] ?? 'cambio') });
      return text(`${prototype} → v${applied.version}`);
    }
    case 'proto_create_prototype': return text(await hub.createPrototype(String(args['title']), args['group'] ? String(args['group']) : undefined, by));
    case 'proto_create_page': return text(await hub.createPage({ prototype, title: String(args['title']), flow: args['flow'] ? String(args['flow']) : undefined, duplicateOf: args['duplicate_of'] ? String(args['duplicate_of']) : undefined, by }));
    case 'proto_history': return text(await hub.history(prototype));
    case 'proto_revert': return text(`${prototype} → v${(await hub.revert(prototype, Number(args['version']), by)).version}`);
    case 'proto_go_to': {
      hub.publish('navigate', { prototype, page: args['page'], node: args['node'] });
      const target = `${url}#/p/${prototype}${args['page'] ? `/${String(args['page'])}` : ''}`;
      return { ...text(`showing ${target}`), structuredContent: { url: target } };
    }
    case 'proto_write_guide': {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const slug = String(args['slug']).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      if (slug === '00-design') throw new Error('Use proto_design for the bounded main specification and reference roles.');
      await mkdir(join(hub.protoDir, 'guide'), { recursive: true });
      await writeFile(join(hub.protoDir, 'guide', `${slug}.md`), String(args['markdown']), 'utf8');
      return text(`guide/${slug}.md written`);
    }
  }
  throw new Error(`unknown tool ${name}`);
};

/** The MCP App: a thin frame around the live storybook, pointed at the URL a tool returned. */
const appHtml = (origin: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{font:13px system-ui;color:#555}</style></head>
<body><iframe id="f" title="pi-proto storybook"></iframe>
<script>
  const frame = document.getElementById('f');
  const show = (url) => { if (url && url.startsWith(${JSON.stringify(origin)})) frame.src = url; };
  const sequence = { id: 1 };
  const send = (method, params) => window.parent.postMessage({ jsonrpc: '2.0', id: sequence.id++, method, params }, '*');
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.method === 'ui/notifications/tool-result') show(msg.params && msg.params.structuredContent && msg.params.structuredContent.url);
    if (msg.id === 1 && msg.result) window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
  });
  send('ui/initialize', { protocolVersion: '2025-06-18', appCapabilities: {}, appInfo: { name: 'pi-proto', version: '1' } });
</script></body></html>`;

/** Handle one JSON-RPC message; undefined for notifications. */
export const handleMcp = async (hubs: Hubs, message: Json): Promise<Json | undefined> => {
  const id = message['id'];
  const method = String(message['method'] ?? '');
  const params = (message['params'] ?? {}) as Json;
  if (id === undefined) return undefined;
  const ok = (result: unknown): Json => ({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: String(params['protocolVersion'] ?? '2025-06-18'),
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'pi-proto', version: '1.0.0' },
          instructions: DESIGNER_PROMPT,
        });
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map(({ ui, ...tool }) => ({ ...tool, ...(ui ? { _meta: { ui: { resourceUri: APP_URI }, 'ui/resourceUri': APP_URI } } : {}) })) });
      case 'tools/call': {
        const result = await callTool(hubs, String(params['name']), (params['arguments'] ?? {}) as Json);
        return ok(result);
      }
      case 'resources/list': return ok({ resources: [{ uri: APP_URI, name: 'pi-proto storybook', mimeType: APP_MIME }] });
      case 'resources/templates/list': return ok({ resourceTemplates: [] });
      case 'prompts/list': return ok({ prompts: [] });
      case 'resources/read': {
        if (params['uri'] !== APP_URI) throw new Error(`no resource ${String(params['uri'])}`);
        const csp = { frameDomains: [hubs.origin], resourceDomains: [hubs.origin], connectDomains: [hubs.origin] };
        return ok({ contents: [{ uri: APP_URI, mimeType: APP_MIME, text: appHtml(hubs.origin), _meta: { ui: { csp, prefersBorder: false } } }] });
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  } catch (error) {
    // Tool failures are results the model can read; protocol failures are errors.
    if (method === 'tools/call') return ok({ ...text(error instanceof Error ? error.message : String(error)), isError: true });
    return { jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
  }
};
