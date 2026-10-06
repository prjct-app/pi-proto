import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, dirname as pathDirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StylingId } from '../config.ts';

export type CssInput = Readonly<{
  /** Path of the source CSS file (or the merged bundle). */
  source: string;
  /** Directory the adapter should scan for class candidates. */
  scanRoot: string;
  /** Where the compiled CSS should be written. */
  outFile: string;
  /** True when `source` is the merged bundle (prepends @source). */
  isBundle?: boolean;
  /** Known candidates avoid rescanning the whole workspace. */
  candidates?: readonly string[];
}>;

export type CssResult = Readonly<{
  outFile: string;
  bytes: number;
  candidates: number;
  adapter: StylingId;
}>;

type AdapterResult = Readonly<{ text: string; candidates: number }>;
type Adapter = (input: CssInput) => Promise<AdapterResult>;

/**
 * Compile one CSS file using the project's adapter. Each adapter is lazy-loaded
 * by `resolveAdapter` so a project that uses `plain` does not pull in PostCSS.
 */
export const compileCss = async (input: CssInput, style: StylingId): Promise<CssResult> => {
  const adapter = await resolveAdapter(style);
  const source = await readFile(input.source, 'utf8');
  const out = await adapter({ ...input, source });
  await mkdir(dirname(input.outFile), { recursive: true });
  await writeFile(input.outFile, out.text, 'utf8');
  return { outFile: input.outFile, bytes: out.text.length, candidates: out.candidates, adapter: style };
};

const resolveAdapter = async (style: StylingId): Promise<Adapter> => {
  switch (style) {
    case 'tw4-postcss': return tw4Postcss;
    case 'tw4-node': return tw4Node;
    case 'tw3': return tw3Postcss;
    case 'plain': return plainAdapter;
  }
};

const SOURCE_DIRECTIVE = (scanRoot: string, outFile: string): string => {
  // Tailwind v4's PostCSS plugin reads @source paths relative to the file the
  // CSS is being processed from. The compiled CSS lives next to `outFile`, so
  // we use a relative path back to the project's screens folder.
  const rel = relativePath(outFile, scanRoot);
  return `@source "${rel}";\n`;
};

const commonPrefix = (a: readonly string[], b: readonly string[]): number => {
  const indices = Array.from({ length: Math.min(a.length - 1, b.length) }, (_, i) => i);
  const mismatch = indices.find(i => a[i] !== b[i]);
  return mismatch === undefined ? Math.min(a.length - 1, b.length) : mismatch;
};

const relativePath = (from: string, to: string): string => {
  const a = from.split('/');
  const b = to.split('/');
  const i = commonPrefix(a, b);
  return '../'.repeat(a.length - 1 - i) + b.slice(i).join('/');
};

const tw4Postcss: Adapter = async ({ source, scanRoot, outFile, candidates }) => {
  const postcss = (await import('postcss')).default;
  const tailwind = (await import('@tailwindcss/postcss')).default;
  const input = candidates ? source + '\n' + candidates.map(c => `@source inline(${JSON.stringify(c)});`).join('\n')
    : SOURCE_DIRECTIVE(scanRoot, outFile) + source;
  // Tailwind v4's PostCSS plugin resolves `tailwindcss` relative to the file
  // being processed. We anchor the resolution to the directory that contains
  // the `tailwindcss` package, then write the output where the caller asked.
  // `base` is the directory the plugin scans for class candidates — it must
  // be the project source root, not the dist folder.
  const from = findTailwindModule() + '/.postcss-anchor.css';
  const result = await postcss([tailwind({ base: scanRoot })]).process(input, { from, to: outFile });
  return { text: result.css, candidates: result.warnings().length };
};

const findTailwindModule = (): string => {
  const req = createRequire(import.meta.url);
  const entry = req.resolve('tailwindcss');
  return pathDirname(entry);
};

const tw3Postcss: Adapter = async ({ source }) => ({ text: source, candidates: 0 });

const tw4Node: Adapter = async ({ source }) => ({ text: source, candidates: 0 });

const plainAdapter: Adapter = async ({ source }) => ({ text: source, candidates: 0 });

/** Bundle every per-screen CSS into one file by concatenation order, then compile it. */
export const bundleCss = async (
  sources: readonly string[],
  scanRoot: string,
  outFile: string,
  style: StylingId,
): Promise<CssResult> => {
  const joined = (await Promise.all(sources.map(s => readFile(s, 'utf8')))).join('\n\n');
  // Every screen starts with `@import "tailwindcss"`; one import is enough, and
  // several would repeat the whole preflight once per screen.
  const TAILWIND_IMPORT = /^\s*@import\s+["']tailwindcss["']\s*;?\s*$/gm;
  const merged = style === 'tw4-postcss' ? `@import "tailwindcss";\n${joined.replace(TAILWIND_IMPORT, '')}` : joined;
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, merged, 'utf8');
  return compileCss({ source: outFile, scanRoot, outFile, isBundle: true }, style);
};
