import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyOps, copyPage, createPrototype, readPrototype, undoLast } from '../src/spec/store.ts';
import { renderWorkspace } from '../src/spec/build.ts';
import { writeDocs } from '../src/docs.ts';
import { auditPrototype } from '../src/spec/audit.ts';
import { interactionsOf } from '../src/spec/sitemap.ts';
import { readTokens, tokensProblems } from '../src/spec/tokens.ts';
import type { Prototype } from '../src/spec/schema.ts';

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-proto-handoff-'));
  try { await mkdir(join(dir, 'guide')); await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};
const tokens = `colors:\n  brand: "#125e55"\n  paper: "#ffffff"\ncomponents:\n  btn-primary:\n    as: button\n    text: Continuar\n    description: Acción principal\n    class: bg-brand text-paper px-4 py-2 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50\n`;

test('named patterns compile once, update all uses through CSS, and leave prototype HTML unchanged', async () => withDir(async dir => {
  await writeFile(join(dir, 'guide', 'tokens.yaml'), tokens);
  await createPrototype(dir, { title: 'Tienda', by: 'agent' });
  await applyOps(dir, 'tienda', [{ op: 'insert', parent: 'inicio', node: { id: 'cta', type: 'button', class: 'btn-primary', text: 'Pagar' } }], { by: 'agent', did: 'botón' });
  await writeDocs(dir);
  assert.equal((await renderWorkspace(dir)).cssChanged, true);
  const firstCss = await readFile(join(dir, 'dist', 'main.css'), 'utf8');
  const firstHtml = await readFile(join(dir, 'dist', 'tienda.html'), 'utf8');
  assert.match(firstCss, /\.btn-primary/);
  assert.match(firstCss, /focus-visible/);
  await writeFile(join(dir, 'guide', 'tokens.yaml'), tokens.replace('px-4', 'px-8'));
  await writeDocs(dir);
  assert.equal((await renderWorkspace(dir, [])).cssChanged, true);
  assert.notEqual(await readFile(join(dir, 'dist', 'main.css'), 'utf8'), firstCss);
  assert.equal(await readFile(join(dir, 'dist', 'tienda.html'), 'utf8'), firstHtml);
  assert.equal((await renderWorkspace(dir, [])).cssChanged, false);
  await writeFile(join(dir, 'guide', 'custom.md'), '# Ejemplo\n\n<div class="p-28">Ejemplo</div>');
  assert.equal((await renderWorkspace(dir, [])).cssChanged, true);
  assert.match(await readFile(join(dir, 'dist', 'main.css'), 'utf8'), /\.p-28/);
}));

test('Entrega includes authored direction, real page entries/exits and findings, preserving notes on regeneration', async () => withDir(async dir => {
  await writeFile(join(dir, 'guide', 'tokens.yaml'), tokens);
  await writeFile(join(dir, 'guide', '01-vision.md'), '# Visión\n\nCompra clara y compacta.\n\n## Principios\n\nContenido primero.');
  await createPrototype(dir, { title: 'Tienda', by: 'agent' });
  await applyOps(dir, 'tienda', [
    { op: 'add_page', page: { id: 'pago', title: 'Pago', flow: 'Compra', children: [{ id: 'email', type: 'input', placeholder: 'Email' }] } },
    { op: 'insert', parent: 'inicio', node: { id: 'comprar', type: 'link', text: 'Comprar', href: '#pago', class: 'btn-primary' } },
  ], { by: 'agent', did: 'compra' });
  await writeDocs(dir);
  const file = join(dir, 'guide', '95-handoff.md');
  const first = await readFile(file, 'utf8');
  assert.match(first, /\[Visión\]\(01-vision\)/);
  assert.doesNotMatch(first, /Compra clara y compacta|Contenido primero/);
  assert.match(first, /btn-primary/);
  assert.match(first, /Inicio.*Entrada inicial.*Comprar: Pago/);
  assert.match(first, /Pago.*Compra.*Inicio.*Sin salida definida/);
  assert.match(first, /email.*Campo sin etiqueta/);
  assert.match(await readFile(join(dir, 'guide', '20-components.md'), 'utf8'), /<button class="btn-primary"/);
  await writeFile(file, `${first}\nDecisión del dev: usar React Native.\n`);
  await writeFile(join(dir, 'guide', '01-vision.md'), '# Visión\n\nNuevo principio editorial.');
  await writeDocs(dir);
  const next = await readFile(file, 'utf8');
  assert.doesNotMatch(next, /Nuevo principio editorial/);
  assert.match(next, /Decisión del dev: usar React Native/);
  assert.doesNotMatch(next, /Compra clara y compacta/);
  assert.equal(await writeDocs(dir), false);
}));

test('deterministic checks include raw HTML, labels, colors, broken links and cross-page toggles', () => {
  const p: Prototype = { proto: 1, id: 'shop', title: 'Shop', version: 1, pages: [
    { id: 'inicio', title: 'Inicio', children: [
      { id: 'raw', type: 'html', html: '<a href="#missing">Roto</a><a href="#pago">Comprar</a><input id="unlabeled"><label for="email">Email</label><input id="email"><button aria-label="Cerrar"></button><img src="x"><span style="color:red">Color</span>' },
      { id: 'color', type: 'text', class: 'bg-red-500 hover:text-blue-600 text-2xl bg-brand', text: 'Hola' },
      { id: 'toggle', type: 'button', text: 'Abrir', on: { click: { toggle: 'modal' } } },
    ] },
    { id: 'pago', title: 'Pago', children: [{ id: 'modal', type: 'box', hidden: true }] },
    { id: 'isla', title: 'Isla', children: [] },
  ] };
  const found = auditPrototype(p, { colors: { brand: '#125e55' } });
  assert.ok(found.some(f => f.code === 'broken-link'));
  assert.ok(found.some(f => f.code === 'cross-page-toggle'));
  assert.equal(found.filter(f => f.code === 'input-label').length, 1);
  assert.equal(found.some(f => f.code === 'control-name'), false);
  assert.equal(found.filter(f => f.code === 'color-token').length, 3);
  assert.ok(found.some(f => f.code === 'image-alt'));
  assert.deepEqual(found.filter(f => f.code === 'orphan-page').map(f => f.page), ['isla']);
  assert.ok(interactionsOf(p).some(i => i.target === 'pago' && i.kind === 'go'));
});

test('invalid tokens and component utilities surface errors and keep the last working CSS and HTML', async () => withDir(async dir => {
  await writeFile(join(dir, 'guide', 'tokens.yaml'), tokens);
  await createPrototype(dir, { title: 'Tienda', by: 'agent' });
  await applyOps(dir, 'tienda', [{ op: 'insert', parent: 'inicio', node: { id: 'cta', type: 'button', class: 'btn-primary', text: 'Pagar' } }], { by: 'agent', did: 'botón' });
  await renderWorkspace(dir);
  const css = await readFile(join(dir, 'dist', 'main.css'), 'utf8');
  const html = await readFile(join(dir, 'dist', 'tienda.html'), 'utf8');
  await applyOps(dir, 'tienda', [{ op: 'set', id: 'titulo', fields: { text: 'Changed' } }], { by: 'agent', did: 'título' });
  await writeFile(join(dir, 'guide', 'tokens.yaml'), tokens.replace('bg-brand', 'this-utility-does-not-exist'));
  await assert.rejects(renderWorkspace(dir), /unknown utility/);
  assert.equal(await readFile(join(dir, 'dist', 'main.css'), 'utf8'), css);
  assert.equal(await readFile(join(dir, 'dist', 'tienda.html'), 'utf8'), html);
  await writeFile(join(dir, 'guide', 'tokens.yaml'), 'colors: [broken');
  await assert.rejects(readTokens(dir));
  assert.ok(tokensProblems({ components: { bad: { class: 'x; } body { color:red' } } }).length);
  assert.ok(tokensProblems({ colors: ['red'] }).length);
}));

test('copied pages keep toggles and self-links inside the copy, and stale undo versions are rejected', async () => withDir(async dir => {
  await createPrototype(dir, { title: 'Tienda', by: 'agent' });
  await applyOps(dir, 'tienda', [
    { op: 'insert', parent: 'inicio', node: { id: 'modal', type: 'box', hidden: true, children: [{ id: 'cerrar', type: 'button', text: 'Cerrar', on: { click: { toggle: 'modal' } } }] } },
    { op: 'insert', parent: 'inicio', node: { id: 'self', type: 'link', text: 'Inicio', on: { click: { go: 'inicio' } } } },
  ], { by: 'agent', did: 'interacciones' });
  const p = await readPrototype(dir, 'tienda');
  const copied = copyPage(p, 'inicio', 'copia', 'Copia');
  const modal = copied.children.find(n => n.type === 'box')!;
  assert.deepEqual(modal.children![0]!.on!.click, { toggle: modal.id });
  assert.deepEqual(copied.children.find(n => n.type === 'link')!.on!.click, { go: 'copia' });
  await assert.rejects(undoLast(dir, 'tienda', 'person', 1), /changed while/);
  assert.equal((await readPrototype(dir, 'tienda')).version, 2);
}));
