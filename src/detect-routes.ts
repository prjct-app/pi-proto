import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StackId } from './config.ts';
import type { Finding } from './detect.ts';

const exists = (root: string, ...parts: readonly string[]): boolean => existsSync(join(root, ...parts));

const PAGE_SUFFIXES = new Set(['page.tsx', 'page.ts', 'page.jsx', 'page.js']);

const fileToRoute = (file: string, prefix: string, stack: StackId): string | undefined => {
  if (stack === 'next-tailwind4' || stack === 'next-tailwind3') {
    const lastSlash = file.lastIndexOf('/');
    const name = lastSlash === -1 ? file : file.slice(lastSlash + 1);
    if (!PAGE_SUFFIXES.has(name)) return undefined;
    if (prefix === '' || prefix === '/') return '/';
    return prefix;
  }
  if (stack === 'astro' || stack === 'vue') {
    const ext = stack === 'astro' ? '.astro' : '.vue';
    if (!file.endsWith(ext)) return undefined;
    const lastSlash = file.lastIndexOf('/');
    const name = lastSlash === -1 ? file : file.slice(lastSlash + 1);
    if (name === `index${ext}`) return prefix || '/';
    const dotIndex = name.lastIndexOf('.');
    return `${prefix}/${dotIndex === -1 ? name : name.slice(0, dotIndex)}`;
  }
  return undefined;
};

const walkRoutes = (root: string, dir: string, prefix: string, stack: StackId, out: Set<string>): void => {
  const entries = readdirSync(join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'api') continue;
    const sub = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nextPrefix = entry.name.startsWith('(') && entry.name.endsWith(')')
        ? prefix
        : `${prefix}/${entry.name}`;
      walkRoutes(root, sub, nextPrefix, stack, out);
    } else if (entry.isFile()) {
      const route = fileToRoute(sub, prefix, stack);
      if (route !== undefined) out.add(route);
    }
  }
};

export const detectRoutes = (root: string, stack: StackId, findings: Finding[]): readonly string[] => {
  const roots: string[] = [];
  if (stack === 'next-tailwind4' || stack === 'next-tailwind3') {
    if (exists(root, 'src/app')) roots.push('src/app');
    else if (exists(root, 'app')) roots.push('app');
  } else if (stack === 'astro' || stack === 'vue') {
    if (exists(root, 'src/pages')) roots.push('src/pages');
    else if (exists(root, 'pages')) roots.push('pages');
  } else {
    if (exists(root, 'src/pages')) roots.push('src/pages');
    else if (exists(root, 'pages')) roots.push('pages');
    if (exists(root, 'src/app')) roots.push('src/app');
    else if (exists(root, 'app')) roots.push('app');
  }
  const routes = new Set<string>();
  for (const dir of roots) walkRoutes(root, dir, '', stack, routes);
  const sorted = [...routes].sort();
  findings.push({ kind: 'routes', value: `${sorted.length} routes`, source: roots.join(', ') || 'none' });
  return sorted;
};
