import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join, sep } from 'node:path';
import { componentPath, PROTO_COMPONENT_NAME } from '../identity.ts';
import { StatusFile } from '../status.ts';
import { SseBus } from '../server/sse.ts';
import { readGuides } from '../story.ts';
import { writeDocs, TOKENS_SLUG, COMPONENTS_SLUG, SITEMAP_SLUG, HANDOFF_SLUG } from '../docs.ts';
import { readSitemap } from '../spec/sitemap.ts';
import { renderWorkspace } from '../spec/build.ts';
import { renderById } from '../spec/render.ts';
import { allIds, applyOps, copyPage, createPrototype, readPrototype, revertTo, undoLast, uniqueId, type Applied } from '../spec/store.ts';
import type { Op, Page } from '../spec/schema.ts';
import type { AgentState, PiState } from '../session-bridge.ts';

/** Bumped when the storybook and the daemon must change together; the page warns on a mismatch. */
export const PROTOCOL = 4;
const CHANNEL = 'story';

type Build = { building: boolean; ok: boolean; error?: string; at?: number };

/** A Pi session working on this project: where messages typed in the storybook go. */
type Session = { id: string; label: string; res: ServerResponse; attachedAt: number; pi?: PiState; agent: AgentState };

/** Where the person is in the storybook, and what they picked: context for the agent. */
export type Viewing = Readonly<{ prototype?: string; page?: string; node?: string; guide?: string; at: number }>;

/**
 * One project's live storybook inside the daemon. Changes come as operations
 * on the YAML; each one renders only its prototype and tells every open page
 * exactly which nodes changed, so a text edit swaps one element in place.
 */
export class ProjectHub {
  readonly protoDir: string;
  readonly bus = new SseBus();
  private readonly status: StatusFile;
  private readonly sessions = new Map<string, Session>();
  private build: Build = { building: false, ok: true };
  /** Versions this hub wrote itself, so the watcher does not render them twice. */
  private readonly written = new Map<string, number>();
  private stopWatch?: () => void;
  private rendering: Promise<unknown> = Promise.resolve();
  private docsTimer?: NodeJS.Timeout;
  private readonly generated = new Set([TOKENS_SLUG, COMPONENTS_SLUG, SITEMAP_SLUG, HANDOFF_SLUG].map(slug => `guide/${slug}.md`));
  private readonly generating = { active: false };
  private readonly generatedTimes = new Map<string, number>();
  private tokensTime?: number;
  viewing: Viewing | undefined;

  constructor(readonly home: string, readonly projectId: string) {
    this.protoDir = componentPath(home, 'project', projectId, PROTO_COMPONENT_NAME);
    this.status = new StatusFile(this.protoDir);
  }

  config() { return this.status.read(); }

  /** Validate an explicit guide/token update without touching prototype YAML. */
  async refreshGuide(): Promise<void> {
    const built = await this.render([]);
    this.scheduleDocs();
    this.publish('story', { at: Date.now() });
    if (!built.ok) throw new Error(`Guide update was saved, but could not render: ${built.error}. Fix the tokens; no prototype operation should be repeated.`);
  }

  publish(event: string, data: unknown): void { this.bus.publish(CHANNEL, event, data); }

  /** Watch and build once; false when the project has no workspace. */
  async start(): Promise<boolean> {
    if (this.stopWatch) return true;
    if (!(await this.config())) return false;
    this.stopWatch = this.watch();
    await this.render();
    return true;
  }

  stop(): void {
    clearTimeout(this.docsTimer);
    this.stopWatch?.();
    this.stopWatch = undefined;
    for (const session of this.sessions.values()) session.res.end();
    this.sessions.clear();
  }

  /** Edits made outside the operations (another tool, a person in an editor) still show up. */
  private watch(): () => void {
    const pending = new Map<string, NodeJS.Timeout>();
    const watcher = watch(this.protoDir, { recursive: true }, (_event, name) => {
      const path = name?.toString().split(sep).join('/') ?? '';
      if (this.generating.active && this.generated.has(path)) return;
      const key = path.startsWith('prototypes/') && path.endsWith('.yaml') ? path
        : path === 'guide/tokens.yaml' ? 'tokens'
        : path.startsWith('guide/') && path.endsWith('.md') ? path : undefined;
      if (!key) return;
      clearTimeout(pending.get(key));
      pending.set(key, setTimeout(() => { pending.delete(key); void this.onFile(key); }, 120));
    });
    watcher.on('error', () => undefined);
    return () => { for (const t of pending.values()) clearTimeout(t); watcher.close(); };
  }

  private async onFile(key: string): Promise<void> {
    if (key.startsWith('guide/')) {
      const next = this.rendering.then(async () => {
        if (this.generated.has(key) && (await stat(join(this.protoDir, key)).catch(() => undefined))?.mtimeMs === this.generatedTimes.get(key)) return;
        await this.renderOnce([]); this.scheduleDocs(); this.publish('story', { at: Date.now() });
      });
      this.rendering = next.catch(() => undefined);
      await next;
      return;
    }
    if (key === 'tokens') {
      const next = this.rendering.then(async () => {
        const time = (await stat(join(this.protoDir, 'guide', 'tokens.yaml')).catch(() => undefined))?.mtimeMs;
        if (time === this.tokensTime) return;
        await this.renderOnce([], 'force'); this.scheduleDocs();
      });
      this.rendering = next.catch(() => undefined);
      await next;
      return;
    }
    const id = key.slice('prototypes/'.length, -'.yaml'.length);
    // Decide inside the render queue, not before waiting behind an edit. A
    // delayed filesystem event must not enqueue a second build of that edit.
    const next = this.rendering.then(async () => {
      const version = await readPrototype(this.protoDir, id).then(p => p.version, () => undefined);
      if (version !== undefined && this.written.get(id) === version) return;
      await this.renderOnce([id]);
      this.scheduleDocs();
      this.publish('prototype', { prototype: id, version, at: Date.now() });
    });
    this.rendering = next.catch(() => undefined);
    await next;
  }

  /** Render prototypes (all by default) and the documentation, and say how it went. */
  render(only?: readonly string[], css?: 'force'): Promise<Build & { cssChanged?: boolean }> {
    const next = this.rendering.then(() => this.renderOnce(only, css), () => this.renderOnce(only, css));
    this.rendering = next.catch(() => undefined);
    return next;
  }

  private async renderOnce(only?: readonly string[], css?: 'force'): Promise<Build & { cssChanged?: boolean }> {
    this.build = { ...this.build, building: true };
    this.publish('building', { at: Date.now() });
    const rendered = { cssChanged: false };
    try {
      const tokensTime = (await stat(join(this.protoDir, 'guide', 'tokens.yaml')).catch(() => undefined))?.mtimeMs;
      // Only startup waits for documentation; individual edits do not.
      if (only === undefined) await this.generateDocs();
      const result = await renderWorkspace(this.protoDir, only, { css });
      rendered.cssChanged = result.cssChanged;
      this.tokensTime = tokensTime;
      if (only === undefined) for (const [id, version] of Object.entries(result.versions)) this.written.set(id, version);
      this.build = { building: false, ok: true, at: Date.now() };
    } catch (error) {
      this.build = { building: false, ok: false, error: error instanceof Error ? error.message : String(error), at: Date.now() };
    }
    this.publish(this.build.ok ? 'built' : 'build-error', { ...this.build, ...rendered });
    return { ...this.build, ...rendered };
  }

  private async generateDocs(): Promise<void> {
    this.generating.active = true;
    try {
      const changed = await writeDocs(this.protoDir);
      await Promise.all([...this.generated].map(async path => {
        const info = await stat(join(this.protoDir, path)).catch(() => undefined);
        if (info) this.generatedTimes.set(path, info.mtimeMs);
      }));
      if (changed) this.publish('story', { at: Date.now() });
    }
    finally { this.generating.active = false; }
  }

  private scheduleDocs(): void {
    clearTimeout(this.docsTimer);
    this.docsTimer = setTimeout(() => {
      this.docsTimer = undefined;
      const next = this.rendering.then(async () => {
        try { await this.generateDocs(); }
        catch (error) { this.publish('docs-error', { error: error instanceof Error ? error.message : String(error) }); }
      });
      this.rendering = next.catch(() => undefined);
    }, 300);
  }

  /**
   * Apply operations as one version, then redraw what they touched: the nodes
   * or pages alone when nothing moved, the whole prototype when pages did.
   */
  async apply(prototype: string, ops: readonly Op[], meta: { by: string; did: string }): Promise<Applied> {
    const applied = await applyOps(this.protoDir, prototype, ops, meta);
    return this.after(prototype, applied);
  }

  async revert(prototype: string, version: number, by: string): Promise<Applied> {
    return this.after(prototype, await revertTo(this.protoDir, prototype, version, by));
  }

  async undo(prototype: string, by: string, expectedVersion?: number): Promise<Applied | undefined> {
    const applied = await undoLast(this.protoDir, prototype, by, expectedVersion);
    return applied && this.after(prototype, applied);
  }

  private async after(prototype: string, applied: Applied): Promise<Applied> {
    this.written.set(prototype, applied.version);
    const built = await this.render([prototype]);
    if (!built.ok) {
      this.publish('story', { at: Date.now() });
      throw new Error(`The change was saved as ${prototype} v${applied.version}, but could not render: ${built.error}. Fix guide/tokens.yaml or the CSS; do not repeat the saved operation.`);
    }
    const { touched } = applied;
    if (touched.structure) {
      this.publish('prototype', { prototype, version: applied.version, at: Date.now() });
    } else {
      const ids = touched.pages.size ? [...touched.pages] : [...touched.nodes];
      const patches = ids.map(id => ({ id, html: renderById(applied.prototype, id) ?? '' })).filter(p => p.html);
      this.publish('patch', { prototype, version: applied.version, patches, css: built.cssChanged, at: Date.now() });
    }
    this.publish('story', { at: Date.now() });
    this.scheduleDocs();
    return applied;
  }

  async createPrototype(title: string, group: string | undefined, by: string): Promise<{ prototype: string }> {
    const created = await createPrototype(this.protoDir, { title, group, by });
    this.written.set(created.id, created.version);
    const built = await this.render([created.id]);
    if (!built.ok) throw new Error(`Prototype ${created.id} was saved, but could not render: ${built.error}. Fix guide/tokens.yaml; do not create it again.`);
    this.scheduleDocs();
    this.publish('story', { at: Date.now() });
    return { prototype: created.id };
  }

  /** A new page, blank or a copy of another, with a readable id. */
  async createPage(input: { prototype: string; title: string; flow?: string; duplicateOf?: string; by: string }): Promise<{ page: string; version: number }> {
    const current = await readPrototype(this.protoDir, input.prototype);
    const taken = allIds(current);
    const base = input.title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pagina';
    const id = uniqueId(base.slice(0, 40), taken);
    const page: Page = input.duplicateOf
      ? copyPage(current, input.duplicateOf, id, input.title, input.flow)
      : { id, title: input.title, ...(input.flow ? { flow: input.flow } : {}), class: 'min-h-screen p-8', children: [{ id: `${id}-titulo`, type: 'text', as: 'h1', class: 'text-3xl font-bold', text: input.title }] };
    const index = input.duplicateOf ? current.pages.findIndex(p => p.id === input.duplicateOf) + 1 : undefined;
    const applied = await this.apply(input.prototype, [{ op: 'add_page', page, ...(index ? { index } : {}) }], { by: input.by, did: input.duplicateOf ? `duplicar ${input.duplicateOf} como ${input.title}` : `nueva página ${input.title}` });
    return { page: id, version: applied.version };
  }

  /** Everything the storybook shows, in one read. */
  async story(): Promise<unknown> {
    const config = await this.config();
    if (!config) return undefined;
    const { prototypes, problems } = await readSitemap(this.protoDir);
    return {
      protocol: PROTOCOL,
      project: { name: config.project.name, projectId: this.projectId, location: config.project.location },
      guides: await readGuides(this.protoDir),
      prototypes: prototypes.map(p => ({ ...p, url: `p/${p.id}.html` })),
      problems,
      build: this.build,
      session: this.sessionSummary(),
      viewing: this.viewing,
    };
  }

  /** The history of a prototype, newest first, without the undo operations. */
  async history(prototype: string): Promise<Array<{ v: number; at: string; by: string; did: string }>> {
    const p = await readPrototype(this.protoDir, prototype);
    return (p.history ?? []).map(({ v, at, by, did }) => ({ v, at, by, did })).reverse();
  }

  async guideSource(slug: string): Promise<string | undefined> {
    return readFile(join(this.protoDir, 'guide', `${slug}.md`), 'utf8').catch(() => undefined);
  }

  // ---- Pi sessions ----

  private active(): Session | undefined {
    return [...this.sessions.values()].sort((a, b) => b.attachedAt - a.attachedAt)[0];
  }

  sessionSummary(): { label: string; pi?: PiState; agent: AgentState } | undefined {
    const session = this.active();
    return session && { label: session.label, pi: session.pi, agent: session.agent };
  }

  attach(id: string, label: string, res: ServerResponse): void {
    this.sessions.set(id, { id, label, res, attachedAt: Date.now(), agent: { state: 'idle' } });
    res.on('close', () => {
      if (this.sessions.get(id)?.res !== res) return;
      this.sessions.delete(id);
      this.publish('session', this.sessionSummary() ?? null);
    });
    this.publish('session', this.sessionSummary() ?? null);
  }

  report(id: string, report: { pi?: PiState; agent?: AgentState; reply?: string; preview?: string }): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (report.pi) session.pi = report.pi;
    if (report.agent) session.agent = report.agent;
    if (session !== this.active()) return true;
    if (report.pi) this.publish('pi', report.pi);
    if (report.agent) this.publish('agent', report.agent);
    if (report.reply) this.publish('reply', { text: report.reply, at: Date.now() });
    if (report.preview) this.publish('preview', { text: report.preview, at: Date.now() });
    return true;
  }

  /** Hand something to the active Pi session; false when no Pi works on this project. */
  toSession(event: string, data: unknown): boolean {
    const session = this.active();
    if (!session) return false;
    session.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  }
}
