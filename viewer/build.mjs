#!/usr/bin/env node
/**
 * Builds the storybook (src/, React) into dist/: one index.html, one app.js
 * with React inlined, one app.css. pi-proto serves dist/ to the browser and
 * loads none of it into Pi.
 */
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: { app: join(root, 'src', 'main.tsx') },
  outdir: out,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
});
await copyFile(join(root, 'src', 'style.css'), join(out, 'app.css'));
await copyFile(join(root, 'index.html'), join(out, 'index.html'));
console.log(`proto-viewer built into ${out}`);
