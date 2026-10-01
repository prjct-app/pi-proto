import { stat } from 'node:fs/promises';
import { fileOf, listPrototypes, readPrototype } from './store.ts';
import type { Prototype, Status } from './schema.ts';
import { parseHTML } from 'linkedom';
import { renderPrototype } from './render.ts';

/**
 * The sitemap, read from the prototypes: which pages each prototype has, in
 * which flows, and where every click leads. It is what the storybook's tree
 * shows, what the generated documentation lists, and what an agent reads to
 * know the structure before it changes one node.
 */

export type Interaction = Readonly<{ page: string; node: string; label: string; kind: 'go' | 'toggle' | 'back'; target?: string }>;

export type SitemapPrototype = Readonly<{
  id: string;
  title: string;
  group?: string;
  description?: string;
  status: Status;
  version: number;
  file: string;
  updatedAt: number;
  pages: ReadonlyArray<Readonly<{ id: string; title: string; flow?: string }>>;
  flows: ReadonlyArray<Readonly<{ name: string; pages: readonly string[] }>>;
  interactions: readonly Interaction[];
}>;

export const interactionsOf = (prototype: Prototype): Interaction[] => {
  const out: Interaction[] = [];
  const { document } = parseHTML(renderPrototype(prototype));
  for (const el of document.querySelectorAll('[data-goto],[data-toggle],[data-back],a[href^="#"]')) {
    const page = el.closest('[data-screen]')?.id;
    if (!page) continue;
    const node = el.closest('[data-node]')?.getAttribute('data-node') ?? el.id;
    const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('alt') || el.getAttribute('placeholder') || node).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (el.hasAttribute('data-back')) { out.push({ page, node, label, kind: 'back' }); continue; }
    const toggle = el.getAttribute('data-toggle');
    if (toggle) { out.push({ page, node, label, kind: 'toggle', target: toggle }); continue; }
    const go = el.getAttribute('data-goto');
    const href = el.getAttribute('href');
    const raw = go ?? (href && href !== '#' ? href.slice(1) : undefined);
    const target = raw ? (() => { try { return decodeURIComponent(raw); } catch { return raw; } })() : undefined;
    if (target && (go || prototype.pages.some(p => p.id === target))) out.push({ page, node, label, kind: 'go', target });
  }
  return out;
};

export const summarize = (prototype: Prototype, updatedAt = 0): SitemapPrototype => {
  const flows: Array<{ name: string; pages: string[] }> = [];
  for (const page of prototype.pages) {
    const name = page.flow ?? '';
    const flow = flows.find(f => f.name === name) ?? (flows.push({ name, pages: [] }), flows.at(-1)!);
    flow.pages.push(page.id);
  }
  return {
    id: prototype.id,
    title: prototype.title,
    ...(prototype.group ? { group: prototype.group } : {}),
    ...(prototype.description ? { description: prototype.description } : {}),
    status: prototype.status ?? 'draft',
    version: prototype.version,
    file: `prototypes/${prototype.id}.yaml`,
    updatedAt,
    pages: prototype.pages.map(p => ({ id: p.id, title: p.title, ...(p.flow ? { flow: p.flow } : {}) })),
    flows,
    interactions: interactionsOf(prototype),
  };
};

/** Every prototype of the workspace; one that fails to parse is reported, not hidden. */
export const readSitemap = async (protoDir: string): Promise<{ prototypes: SitemapPrototype[]; problems: string[] }> => {
  const prototypes: SitemapPrototype[] = [];
  const problems: string[] = [];
  for (const id of await listPrototypes(protoDir)) {
    try {
      const prototype = await readPrototype(protoDir, id);
      prototypes.push(summarize(prototype, await stat(fileOf(protoDir, id)).then(s => s.mtimeMs, () => 0)));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  const order = (p: SitemapPrototype): number => (p.id === 'inicio' ? -1 : 0);
  prototypes.sort((a, b) => order(a) - order(b) || (a.group ?? '').localeCompare(b.group ?? '') || a.title.localeCompare(b.title));
  return { prototypes, problems };
};
