import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ProtoController } from './host.ts';
import { call } from './client.ts';
import { openDefaultBrowser } from './browser/system.ts';
import { StatusFile } from './status.ts';
import type { Reference } from './design-guide.ts';

/**
 * The agent's tools. Prototypes are versioned YAML (node trees with ids) that
 * the daemon renders to HTML; the agent reads a prototype, then changes it with
 * small operations on ids, so a change costs a few lines and the open
 * storybook swaps only the nodes that changed.
 */

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (value: string, details?: Record<string, unknown>): { content: Content[]; details: Record<string, unknown> | undefined } => ({ content: [{ type: 'text', text: value }], details });

const OPS = 'Ops: {op:"set",id,fields} (null removes a field); {op:"insert",parent,index?,node}; '
  + '{op:"remove",id}; {op:"move",id,parent,index?}; {op:"add_page",page:{id,title,children},index?}; '
  + '{op:"remove_page",id}; {op:"set_prototype",fields:{title,group,description,status}}. '
  + 'Nodes: {id,type,class?,text?,as?,children?}; types box/stack/row/grid/text/image/button/input/textarea/link/icon/divider/html. '
  + 'Clicks: on:{click:{go:"page"}} | {toggle:"node"} | {back:true}; hidden:true starts an overlay closed. '
  + 'Use existing ids, Tailwind v4 and named token/component classes. Only requested screen work.';

export const registerTools = (pi: ExtensionAPI, controller: ProtoController): void => {
  pi.registerTool({
    name: 'proto_context', label: 'proto_context',
    description: 'Read the current framework-neutral design guide, bounded project evidence, detected UI libraries and supported pi-memory decisions in one local call. No model, build, prototype or workspace writes. Start here; inspect only a relevant source afterward. frontend selects a package inside a multi-app repository.',
    parameters: Type.Object({ frontend: Type.Optional(Type.String()), refresh: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(_id, params) { return text(await controller.context(params)); },
  });
  pi.registerTool({
    name: 'proto_init',
    label: 'proto_init',
    description: 'Prepare a design workspace only. No prototype, visual identity or browser opening by default. Choose artifact: prototype only when screens were explicitly requested; tokens/guide do not authorize screen work.',
    parameters: Type.Object({
      artifact: Type.Optional(Type.Union([Type.Literal('workspace'), Type.Literal('tokens'), Type.Literal('guide'), Type.Literal('prototype')])),
      open_browser: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, onUpdate) {
      onUpdate?.({ content: [{ type: 'text', text: 'Preparing Prototype…' }], details: undefined });
      const c = await controller.connect({ init: true, artifact: params.artifact });
      const opened = params.open_browser ? await openDefaultBrowser(c.base) : false;
      return text([
        `Prototype: ${c.base}${opened ? ' (opened in the browser)' : ''}.`,
        `Workspace: ${c.project.protoDir}`,
        'proto_tokens: token values. proto_design: compact specification. Use only the requested artifact; stop when it is done.',
      ].join('\n'), { url: c.base });
    },
  });

  pi.registerTool({
    name: 'proto_tokens', label: 'proto_tokens',
    description: 'Read tokens (optionally one group), or merge provided token/component values without changing prototypes. Derive values from inspected references, never generic defaults. Writes return a short acknowledgement.',
    parameters: Type.Object({
      group: Type.Optional(Type.String()),
      tokens: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const c = await controller.connect({ init: true, artifact: 'tokens' });
      if (params.tokens) {
        await call(c.base, 'api/tokens', { tokens: params.tokens });
        return text('Updated guide/tokens.yaml. No prototypes changed.');
      }
      const tokens = await call(c.base, `api/tokens${params.group ? `?group=${encodeURIComponent(params.group)}` : ''}`);
      const { default: YAML } = await import('yaml');
      const yaml = YAML.stringify(tokens, { lineWidth: 0 });
      return text(yaml.length > 12_000 ? 'Token set is large. Read one group: colors, fonts, radius, spacing, text or components.' : yaml);
    },
  });

  pi.registerTool({
    name: 'proto_design', label: 'proto_design',
    description: 'Read/write the stable framework-neutral design guide (500-word core incl. references). Explain scope, visual rationale, hierarchy, composition, density, type/color roles, states, requested navigation, patterns to preserve/avoid and unresolved decisions. Not a mandatory component catalogue. References: target=desired, current=baseline, constraint=preserve. Link values/evidence instead of duplicating them.',
    parameters: Type.Object({
      markdown: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      references: Type.Optional(Type.Array(Type.Object({
        source: Type.String({ minLength: 1, maxLength: 400 }),
        role: Type.Union(['target', 'current', 'constraint'].map(v => Type.Literal(v))),
        notes: Type.String({ minLength: 1, maxLength: 300 }),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 8 })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const c = await controller.connect({ init: true, artifact: 'guide' });
      if (params.markdown !== undefined) {
        await call(c.base, 'api/design', { markdown: params.markdown, references: params.references as Reference[] });
        return text('Saved guide/00-design.md (≤500 words). No prototypes changed.');
      }
      const result = await call<{ markdown?: string }>(c.base, 'api/design');
      return text(result.markdown ?? 'No authored specification. Inspect the requested references and record decisions with proto_design; generated Entrega is only an index, not a design direction.');
    },
  });

  pi.registerTool({
    name: 'proto_sitemap',
    label: 'proto_sitemap',
    description: 'Compact prototype index. Supply prototype to read its page/flow/click structure; flow order is not navigation. Not needed for a tokens-only or document-only task.',
    parameters: Type.Object({ prototype: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params) {
      const c = await controller.connect();
      const story = await call<{ prototypes: Array<{ id: string; title: string; group?: string; status: string; version: number; flows: Array<{ name: string; pages: string[] }>; pages: Array<{ id: string; title: string }>; interactions: Array<{ page: string; node: string; kind: string; target?: string }> }>; problems: string[]; viewing?: { prototype?: string; page?: string; node?: string } }>(c.base, 'api/story');
      const lines = story.prototypes.filter(p => !params.prototype || p.id === params.prototype).map(p => {
        if (!params.prototype) return `${p.id} "${p.title}" v${p.version} ${p.status}: ${p.pages.length} pages`;
        const flows = p.flows.map(f => `${f.name ? `${f.name}: ` : ''}${f.pages.join(', ')}`);
        return `${p.id} "${p.title}"${p.group ? ` [${p.group}]` : ''} v${p.version} ${p.status}\n  ${flows.join('\n  ')}\n  clicks: ${p.interactions.map(i => `${i.page}/${i.node} ${i.kind}${i.target ? ` ${i.target}` : ''}`).join(', ') || 'none'}`;
      });
      if (story.viewing?.prototype) lines.push(`The person is looking at ${story.viewing.prototype}${story.viewing.page ? ` › ${story.viewing.page}` : ''}${story.viewing.node ? ` › ${story.viewing.node}` : ''}.`);
      for (const problem of story.problems) lines.push(`⚠ ${problem}`);
      return text(lines.join('\n') || 'No prototypes yet.');
    },
  });

  pi.registerTool({
    name: 'proto_read',
    label: 'proto_read',
    description: 'A prototype as YAML with its node ids (without its history), or one page of it. Read the relevant page before editing when its current YAML was not already supplied by the composer.',
    parameters: Type.Object({ prototype: Type.String(), page: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params) {
      const c = await controller.connect();
      const { yaml } = await call<{ yaml: string }>(c.base, `api/prototype?id=${encodeURIComponent(params.prototype)}&format=yaml`);
      if (!params.page) return text(yaml);
      const { default: YAML } = await import('yaml');
      const page = (YAML.parse(yaml) as { pages: Array<{ id: string }> }).pages.find(p => p.id === params.page);
      if (!page) throw new Error(`no page "${params.page}" in ${params.prototype}.`);
      return text(YAML.stringify(page, { lineWidth: 0 }));
    },
  });

  pi.registerTool({
    name: 'proto_edit',
    label: 'proto_edit',
    description: `Change a prototype with small operations on node ids; it becomes a new version and Prototype redraws only what changed. ${OPS}`,
    parameters: Type.Object({
      prototype: Type.String(),
      ops: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1 }),
      did: Type.String({ description: 'What the change does, in a few words, for the history (in the person\'s language).' }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const c = await controller.connect();
      const r = await call<{ version: number }>(c.base, 'api/ops', { prototype: params.prototype, ops: params.ops, did: params.did, by: 'agent' });
      return text(`${params.prototype} → v${r.version}.`);
    },
  });

  pi.registerTool({
    name: 'proto_create',
    label: 'proto_create',
    description: 'Create a prototype (give title, and group for variants of the same thing), or a page in one (give prototype and title; flow groups pages; duplicate_of copies a page).',
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      prototype: Type.Optional(Type.String({ description: 'Add a page to this prototype instead of creating a prototype.' })),
      group: Type.Optional(Type.String()),
      flow: Type.Optional(Type.String()),
      duplicate_of: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const c = await controller.connect();
      if (!params.prototype) {
        const r = await call<{ prototype: string }>(c.base, 'api/create_prototype', { title: params.title, group: params.group, by: 'agent' });
        return text(`Created prototype ${r.prototype} with page "inicio".`);
      }
      const r = await call<{ page: string; version: number }>(c.base, 'api/create_page', { prototype: params.prototype, title: params.title, flow: params.flow, duplicateOf: params.duplicate_of, by: 'agent' });
      return text(`Added page ${r.page} to ${params.prototype} (v${r.version}).`);
    },
  });

  pi.registerTool({
    name: 'proto_history',
    label: 'proto_history',
    description: 'The versions of a prototype, newest first. With revert_to, go back to that version as a new version (nothing is lost).',
    parameters: Type.Object({ prototype: Type.String(), revert_to: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
    async execute(_id, params) {
      const c = await controller.connect();
      if (params.revert_to !== undefined) {
        const r = await call<{ version: number }>(c.base, 'api/revert', { prototype: params.prototype, version: params.revert_to, by: 'agent' });
        return text(`${params.prototype} is back to v${params.revert_to}, as v${r.version}.`);
      }
      const history = await call<Array<{ v: number; at: string; by: string; did: string }>>(c.base, `api/history?id=${encodeURIComponent(params.prototype)}`);
      return text(history.slice(0, 30).map(h => `v${h.v} ${h.at.slice(0, 16).replace('T', ' ')} ${h.by}: ${h.did}`).join('\n'));
    },
  });

  pi.registerTool({
    name: 'proto_show',
    label: 'proto_show',
    description: 'Show a prototype page (and highlight a node) in Prototype; open_browser opens it in the person\'s browser too.',
    parameters: Type.Object({
      prototype: Type.String(),
      page: Type.Optional(Type.String()),
      node: Type.Optional(Type.String()),
      open_browser: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const c = await controller.connect();
      await call(c.base, 'api/go_to', { prototype: params.prototype, page: params.page, node: params.node });
      const url = `${c.base}#/p/${params.prototype}${params.page ? `/${params.page}` : ''}`;
      if (params.open_browser) await openDefaultBrowser(url);
      return text(`Showing ${url}.`);
    },
  });

  pi.registerTool({
    name: 'proto_shot',
    label: 'proto_shot',
    description: 'Screenshot a prototype page at the configured viewports and attach the images, to see what you built before telling the person.',
    parameters: Type.Object({ prototype: Type.String(), page: Type.Optional(Type.String()), viewport: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params, _signal, onUpdate) {
      const c = await controller.connect();
      const config = await new StatusFile(c.project.protoDir).read();
      const viewports = (config?.viewports ?? []).filter(v => !params.viewport || v.label === params.viewport);
      if (!viewports.length) throw new Error(`no viewport "${params.viewport}".`);
      onUpdate?.({ content: [{ type: 'text', text: 'Tomando capturas…' }], details: undefined });
      const { launchAndShoot } = await import('./browser/launch.ts');
      const outDir = join(c.project.protoDir, 'shoot', params.prototype, params.page ?? 'first');
      await mkdir(outDir, { recursive: true });
      const shots = await launchAndShoot({ url: `${c.base}p/${params.prototype}.html${params.page ? `#${params.page}` : ''}`, channel: 'story', viewports, outDir });
      const images: Content[] = await Promise.all(shots.slice(0, 4).map(async s => ({ type: 'image' as const, data: (await readFile(s.file)).toString('base64'), mimeType: 'image/png' })));
      return { content: [{ type: 'text', text: shots.map(s => `${s.viewport} (${s.width}px): ${s.file}`).join('\n') }, ...images], details: undefined };
    },
  });

  pi.registerTool({
    name: 'proto_reply',
    label: 'proto_reply',
    description: 'Say something in the Prototype conversation. Your final answer reaches it by itself.',
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      await controller.connect();
      controller.say(params.text);
      return text('Sent to Prototype.');
    },
  });
};
