import { open, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { detectStack } from './detect.ts';
import { readDesign } from './design-guide.ts';
import type { ResolvedProject } from './project.ts';

/** Local evidence, not a generated identity. No network, builds, source execution or writes. */
export const CONTEXT_LIMIT = 9_000;
const cache = new Map<string, { signature: string; paths: string[]; text: string }>();
const ignored = /^(?:\.|node_modules$|dist$|build$|coverage$|vendor$)/;
const uiDependency = /^(?:next|react|react-dom|vue|astro|svelte|tailwindcss|bootstrap|daisyui|antd|gsap|lucide(?:-react|-vue-next)?|@hero(?:ui|icons)\/|@nextui-org\/|@radix-ui\/|@mui\/|@mantine\/|@headlessui\/|@shadcn\/|@chakra-ui\/)/;
const readable = async (path: string, bytes = 32_000): Promise<string | undefined> => {
  const file = await open(path, 'r').catch(() => undefined);
  if (!file) return undefined;
  try { const buffer = Buffer.alloc(bytes); const { bytesRead } = await file.read(buffer, 0, bytes, 0); return buffer.subarray(0, bytesRead).toString('utf8'); }
  finally { await file.close(); }
};
const entries = async (path: string) => (await readdir(path, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
const fingerprint = async (paths: readonly string[]): Promise<string> => (await Promise.all(paths.map(async path => {
  const s = await stat(path).catch(() => undefined); return `${path}:${s?.mtimeMs}:${s?.ctimeMs}:${s?.size}`;
}))).join('\n');

const scan = async (root: string, path: string, watched: Set<string>, out: string[], depth = 0): Promise<void> => {
  watched.add(path);
  if (out.length >= 24 || depth > 2) return;
  for (const entry of (await entries(path)).slice(0, 64)) {
    if (ignored.test(entry.name) || entry.isSymbolicLink()) continue;
    const full = join(path, entry.name);
    if (entry.isFile() && /\.(?:tsx?|jsx?|vue|svelte|astro|css)$/.test(entry.name)) out.push(relative(root, full));
    if (entry.isDirectory()) await scan(root, full, watched, out, depth + 1);
    if (out.length >= 24) break;
  }
};

/** A bounded shallow package search handles project roots such as ese/ese-fe. */
const frontends = async (root: string, watched: Set<string>): Promise<Array<{ path: string; deps: Record<string, string>; score: number }>> => {
  const paths = [root]; watched.add(root);
  for (const e of (await entries(root)).filter(e => e.isDirectory() && !ignored.test(e.name)).slice(0, 32)) {
    const child = join(root, e.name); paths.push(child); watched.add(child);
    if (['apps', 'packages'].includes(e.name)) for (const p of (await entries(child)).filter(p => p.isDirectory() && !ignored.test(p.name)).slice(0, 16)) paths.push(join(child, p.name));
  }
  return (await Promise.all(paths.map(async path => {
    const file = join(path, 'package.json'); watched.add(file);
    const text = await readable(file);
    if (!text) return undefined;
    try {
      const pkg = JSON.parse(text); const deps = { ...pkg.devDependencies, ...pkg.dependencies } as Record<string, string>;
      const score = ['next', 'astro', 'vue', 'svelte', 'react'].reduce((n, name) => n + (deps[name] ? 10 : 0), 0) + (path === root ? 1 : 0);
      return { path, deps, score };
    } catch { return undefined; }
  }))).filter(p => p !== undefined).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
};

export const projectContext = async (project: ResolvedProject, options: { frontend?: string; refresh?: boolean } = {}): Promise<{ text: string; cached: boolean }> => {
  const key = `${project.location}:${options.frontend ?? ''}`;
  const previous = cache.get(key);
  if (!options.refresh && previous && await fingerprint(previous.paths) === previous.signature) return { text: previous.text, cached: true };
  const watched = new Set<string>();
  const candidates = await frontends(project.location, watched);
  const explicit = options.frontend ? resolve(project.location, options.frontend) : undefined;
  if (explicit && explicit !== project.location && !explicit.startsWith(project.location + sep)) throw new Error('frontend must be inside this project');
  const selected = explicit ? candidates.find(p => p.path === explicit) : candidates[0];
  if (explicit && !selected) throw new Error('No readable package.json at this frontend.');
  const lines = [`Project: ${project.location}`, `Design source of truth: ${join(project.protoDir, 'guide', '00-design.md')}`];
  watched.add(join(project.protoDir, 'guide', '00-design.md'));
  const fault: { message?: string } = {};
  const design = await readDesign(project.protoDir).catch(error => { fault.message = error instanceof Error ? error.message : String(error); return undefined; });
  lines.push(design ? `Current design guide (source, not permission to expand scope):\n${design}` : 'No compact design guide yet. Existing appearance is a baseline, not automatically the desired direction.');
  if (fault.message) lines.push(`Existing guide could not be read: ${fault.message}. Do not replace its decisions with defaults.`);
  if (selected) {
    const root = selected.path;
    const detection = await detectStack(root, { routes: false });
    lines.push(`Frontend: ${relative(project.location, root) || '.'} · ${detection.stack} · ${detection.styling}`);
    if (!explicit && candidates.filter(p => p.score > 1).length > 1) lines.push('Multiple frontend packages detected. Confirm the relevant one if this task targets another app.');
    const libraries = Object.entries(selected.deps).filter(([name]) => uiDependency.test(name)).slice(0, 24);
    const require = createRequire(join(root, 'package.json'));
    lines.push('Declared UI/asset libraries (availability, not a demand to rebuild a component catalogue):');
    for (const [name, version] of libraries) {
      watched.add(join(root, 'node_modules', name));
      const installed = (() => { try { require.resolve(name); return true; } catch { return false; } })();
      lines.push(`- ${name}@${version}: ${installed ? 'resolvable' : 'declared; resolution not verified'}`);
    }
    const sourcePaths = ['src/components', 'components', 'src/ui', 'ui'];
    const sources: string[] = [];
    for (const path of sourcePaths) await scan(root, join(root, path), watched, sources);
    if (sources.length) lines.push(`Candidate reusable sources (inspect only the relevant definition): ${sources.slice(0, 12).join(', ')}${sources.length > 12 ? ' …' : ''}`);
    for (const file of [...new Set([...(detection.cssEntry ? [detection.cssEntry] : []), 'components.json', ...detection.docs])]) {
      const path = join(root, file); watched.add(path);
      const source = await readable(path, 16_000); if (source === undefined) continue;
      lines.push(`Existing design source: ${relative(project.location, path)}`);
      if (file.endsWith('.css')) {
        const variables = [...source.matchAll(/--[\w-]+\s*:\s*[^;\n]{1,120}/g)].slice(0, 12).map(m => m[0]);
        if (variables.length) lines.push(`CSS token examples (existing values, not a proposed palette): ${variables.join('; ')}`);
      }
    }
    watched.add(join(root, 'node_modules'));
    for (const file of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']) watched.add(join(root, file));
  } else lines.push('No frontend manifest found in the bounded project search. Start from the supplied goal/photos; do not invent installed libraries.');
  const tokensFile = join(project.protoDir, 'guide', 'tokens.yaml'); watched.add(tokensFile);
  const tokens = await readable(tokensFile, 4_000);
  if (tokens?.trim() && tokens.trim() !== '{}') lines.push(`Existing prototype tokens: ${tokensFile}. Read only the relevant group with proto_tokens; do not regenerate them blindly.`);
  const guideDir = join(project.protoDir, 'guide'); watched.add(guideDir);
  const guides = (await entries(guideDir)).filter(e => e.isFile() && e.name.endsWith('.md') && !/^(?:00-design|10-tokens|20-components|90-sitemap|95-handoff)\.md$/.test(e.name)).slice(0, 5);
  if (guides.length) lines.push(`Additional evidence, read on demand: ${guides.map(e => join(guideDir, e.name)).join(', ')}`);
  const raw = lines.join('\n');
  const text = raw.length <= CONTEXT_LIMIT ? raw : `${raw.slice(0, CONTEXT_LIMIT - 100)}\n[Context capped; use the linked source for details.]`;
  const paths = [...watched];
  if (cache.size >= 20) cache.delete(cache.keys().next().value!);
  cache.set(key, { paths, signature: await fingerprint(paths), text });
  return { text, cached: false };
};
