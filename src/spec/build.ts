import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCss } from '../build/css.ts';
import { listPrototypes, readPrototype } from './store.ts';
import { classesOf, renderPrototype } from './render.ts';
import { readTokens, themeCss, componentsCss, componentsMarkdown, tokensMarkdown } from './tokens.ts';
import { readGuides } from '../story.ts';
import { guideDocument } from '../guide-page.ts';

/**
 * Render the YAML prototypes into dist/: one HTML per prototype, one main.css
 * compiled by Tailwind v4 from the classes they use and the design tokens, and
 * the runtime that makes pages, links and toggles work. A change to one
 * prototype renders only that one, and recompiles CSS only when the set of
 * classes or the tokens changed.
 */

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** The browser runtime and GSAP ship with pi-proto, found next to this module (or its mirror in the build). */
const RUNTIME_JS = fileURLToPath(new URL('../runtime-browser/runtime.js', import.meta.url));
const gsapFile = (): string | undefined => {
  try { return createRequire(import.meta.url).resolve('gsap/dist/gsap.min.js'); } catch { return undefined; }
};

export const distDir = (protoDir: string): string => join(protoDir, 'dist');

export type RenderResult = Readonly<{ rendered: string[]; cssChanged: boolean; versions: Record<string, number> }>;

const vendor = async (outDir: string): Promise<void> => {
  const gsap = gsapFile();
  if (gsap && !(await exists(join(outDir, 'gsap.js')))) await cp(gsap, join(outDir, 'gsap.js'));
  // The runtime is always refreshed: it is small and changes with pi-proto.
  if (await exists(RUNTIME_JS)) await cp(RUNTIME_JS, join(outDir, 'proto.js'));
};

/** Render `only` (or every) prototype, then CSS if its inputs changed. */
export const renderWorkspace = async (protoDir: string, only?: readonly string[], options: { css?: 'force' } = {}): Promise<RenderResult> => {
  const outDir = distDir(protoDir);
  await mkdir(outDir, { recursive: true });
  await vendor(outDir);
  const all = await listPrototypes(protoDir);
  const ids = only ? all.filter(id => only.includes(id)) : all;
  const versions: Record<string, number> = {};
  const documents: Array<{ id: string; html: string }> = [];
  const classes = new Set<string>();
  for (const id of all) {
    const prototype = await readPrototype(protoDir, id);
    for (const c of classesOf(prototype)) classes.add(c);
    if (!ids.includes(id)) continue;
    documents.push({ id, html: renderPrototype(prototype) });
    versions[id] = prototype.version;
  }
  const design = await readTokens(protoDir);
  const tokens = themeCss(design) + componentsCss(design);
  // Guide examples also contribute classes; changing a Markdown example can
  // require CSS even when the prototypes and tokens stayed the same.
  const guides = await Promise.all((await readGuides(protoDir)).map(async g =>
    guideDocument(await readFile(g.file, 'utf8'), g.title, 'main.css')));
  // Fresh examples contribute classes without awaiting docs regeneration.
  guides.push(guideDocument(componentsMarkdown(design) + '\n' + tokensMarkdown(design), 'Tokens', 'main.css'));
  for (const guide of guides) for (const match of guide.matchAll(/class="([^"]+)"/g)) {
    for (const c of match[1]!.split(/\s+/).filter(Boolean)) classes.add(c);
  }
  const fingerprint = createHash('sha256').update(tokens).update([...classes].sort().join(' ')).digest('hex');
  const stamp = join(outDir, '.css-inputs');
  const cssChanged = options.css === 'force' || (await readFile(stamp, 'utf8').catch(() => '')) !== fingerprint || !(await exists(join(outDir, 'main.css')));
  if (cssChanged) {
    const input = join(outDir, '.main.in.css');
    await writeFile(input, `@import "tailwindcss" source(none);\n${tokens}`, 'utf8');
    // Scan exactly the live classes, not dist/, undo history or other files.
    await compileCss({ source: input, scanRoot: protoDir, outFile: join(outDir, 'main.css'), candidates: [...classes] }, 'tw4-postcss');
    await writeFile(stamp, fingerprint, 'utf8');
  }
  // Commit rendered pages only after CSS compiles. A bad component utility
  // leaves the previous working pages and stylesheet available.
  for (const document of documents) await writeFile(join(outDir, `${document.id}.html`), document.html, 'utf8');
  return { rendered: Object.keys(versions), cssChanged, versions };
};
