import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectStack } from '../src/detect.ts';

const withProject = async (files: Record<string, string>, fn: (root: string) => Promise<void> | void): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'pi-proto-detect-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('detectStack: plain HTML+CSS project', async () => {
  await withProject({
    'package.json': JSON.stringify({ name: 'plain', scripts: { build: 'tailwindcss -i css/in.css -o dist/out.css' } }),
    'index.html': '<html><head><link rel="stylesheet" href="css/main.css"></head><body></body></html>',
    'css/main.css': '@import "tailwindcss";',
  }, async root => {
    const result = await detectStack(root);
    assert.equal(result.stack, 'plain');
    assert.equal(result.styling, 'tw4-postcss');
    assert.equal(result.cssEntry, 'css/main.css');
    assert.equal(result.routes.length, 0);
  });
});

test('detectStack: next.js app router project', async () => {
  await withProject({
    'package.json': JSON.stringify({ name: 'app', dependencies: { next: '15.0.0', react: '19.0.0' } }),
    'next.config.mjs': 'export default {};',
    'postcss.config.mjs': JSON.stringify({ plugins: { '@tailwindcss/postcss': {} } }),
    'app/layout.tsx': 'export default function L(){}',
    'app/page.tsx': 'export default function P(){}',
    'app/staff/solicitudes/page.tsx': 'export default function P(){}',
    'app/(auth)/login/page.tsx': 'export default function P(){}',
  }, async root => {
    const result = await detectStack(root);
    assert.equal(result.stack, 'next-tailwind4');
    assert.equal(result.styling, 'tw4-postcss');
    assert.ok(result.routes.includes('/'));
    assert.ok(result.routes.includes('/staff/solicitudes'));
    assert.ok(result.routes.includes('/login'), 'route group must be stripped');
  });
});

test('detectStack: astro project', async () => {
  await withProject({
    'package.json': JSON.stringify({ name: 'site', dependencies: { astro: '5.0.0' } }),
    'src/pages/index.astro': '---',
    'src/pages/blog/post-1.astro': '---',
    'src/pages/blog/index.astro': '---',
  }, async root => {
    const result = await detectStack(root);
    assert.equal(result.stack, 'astro');
    assert.ok(result.routes.includes('/'));
    assert.ok(result.routes.includes('/blog'));
    assert.ok(result.routes.includes('/blog/post-1'));
  });
});

test('detectStack: tailwind v3 fallback', async () => {
  await withProject({
    'package.json': JSON.stringify({ name: 'site', dependencies: { tailwindcss: '3.4.0' } }),
    'tailwind.config.js': 'module.exports = { content: [] };',
    'postcss.config.js': 'module.exports = { plugins: { tailwindcss: {} } };',
    'src/index.css': '@tailwind base; @tailwind components; @tailwind utilities;',
  }, async root => {
    const result = await detectStack(root);
    assert.equal(result.styling, 'tw3');
  });
});

test('detectStack: major-only Tailwind ranges and HeroUI React are not misclassified', async () => {
  await withProject({
    'package.json': JSON.stringify({ dependencies: { next: '16.0.0', tailwindcss: '^4', '@heroui/react': '2.8.5' } }),
    'src/app/globals.css': '@import "tailwindcss";',
  }, async root => {
    const result = await detectStack(root, { routes: false });
    assert.equal(result.stack, 'next-tailwind4'); assert.equal(result.uiLibrary, '@heroui/react');
    assert.deepEqual(result.routes, [], 'fast inventory does not recursively discover all routes');
  });
});

test('detectStack: missing design docs are referenced but not present', async () => {
  await withProject({
    'package.json': JSON.stringify({ name: 'plain' }),
    'index.html': '',
  }, async root => {
    const result = await detectStack(root);
    const docKinds = result.docs;
    assert.ok(docKinds.every(d => typeof d === 'string'));
    assert.ok(docKinds.some(d => d.endsWith('DESIGN.md') || d.endsWith('.impeccable/front-end-guidelines.md')));
  });
});
