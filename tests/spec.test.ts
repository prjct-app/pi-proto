import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { applyOps, copyPage, createPrototype, readPrototype, revertTo, toYaml } from '../src/spec/store.ts';
import { prototypeProblems } from '../src/spec/schema.ts';
import { renderById, renderPrototype } from '../src/spec/render.ts';
import { readSitemap } from '../src/spec/sitemap.ts';
import { sitemapMarkdown, mergeGenerated, writeDocs } from '../src/docs.ts';
import { renderWorkspace } from '../src/spec/build.ts';
import { STARTER_TOKENS, themeCss } from '../src/spec/tokens.ts';

const withDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-proto-spec-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('a new prototype is valid YAML at version 1 with its own history', async () => {
  await withDir(async dir => {
    const p = await createPrototype(dir, { title: 'Tienda Online', by: 'person' });
    assert.equal(p.id, 'tienda-online');
    const text = readFileSync(join(dir, 'prototypes', 'tienda-online.yaml'), 'utf8');
    const parsed = YAML.parse(text);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.history[0].did, 'crear el prototipo');
    assert.deepEqual(prototypeProblems(parsed), []);
    assert.equal((await createPrototype(dir, { title: 'Tienda Online', by: 'person' })).id, 'tienda-online-2');
  });
});

test('one change is one version; it touches only the node it names, and undoes', async () => {
  await withDir(async dir => {
    await createPrototype(dir, { title: 'Tienda', by: 'person' });
    const added = await applyOps(dir, 'tienda', [
      { op: 'add_page', page: { id: 'pago', title: 'Pago', flow: 'Compra', children: [] } },
      { op: 'insert', parent: 'pago', node: { id: 'pagar', type: 'button', text: 'Pagar', class: 'bg-brand text-white' } },
      { op: 'insert', parent: 'inicio', node: { id: 'comprar', type: 'button', text: 'Comprar', on: { click: { go: 'pago' } } } },
    ], { by: 'agent', did: 'flujo de compra' });
    assert.equal(added.version, 2);
    const changed = await applyOps(dir, 'tienda', [{ op: 'set', id: 'pagar', fields: { text: 'Pagar $19' } }], { by: 'person', did: 'cambiar el texto' });
    assert.deepEqual([...changed.touched.nodes], ['pagar']);
    assert.equal(changed.touched.structure, false);
    assert.match(renderById(changed.prototype, 'pagar')!, /^<button id="pagar" data-node="pagar" class="bg-brand text-white" type="button">Pagar \$19<\/button>$/);
    // Going back undoes both later versions, as a new version.
    const back = await revertTo(dir, 'tienda', 1, 'person');
    assert.equal(back.version, 4);
    const now = await readPrototype(dir, 'tienda');
    assert.deepEqual(now.pages.map(p => p.id), ['inicio']);
    assert.equal(now.history!.at(-1)!.did, 'volver a la versión 1');
    // And forward again: undoing the revert restores the flow.
    await revertTo(dir, 'tienda', 3, 'person');
    const again = await readPrototype(dir, 'tienda');
    assert.deepEqual(again.pages.map(p => p.id), ['inicio', 'pago']);
    assert.equal(renderById(again, 'pagar')!.includes('Pagar $19'), true);
  });
});

test('a change that would break the prototype leaves the file as it was', async () => {
  await withDir(async dir => {
    await createPrototype(dir, { title: 'Tienda', by: 'person' });
    const before = readFileSync(join(dir, 'prototypes', 'tienda.yaml'), 'utf8');
    await assert.rejects(applyOps(dir, 'tienda', [{ op: 'set', id: 'titulo', fields: { on: { click: { go: 'nowhere' } } } }], { by: 'agent', did: 'x' }), /no page "nowhere"/);
    await assert.rejects(applyOps(dir, 'tienda', [{ op: 'remove_page', id: 'inicio' }], { by: 'agent', did: 'x' }), /at least one page/);
    assert.equal(readFileSync(join(dir, 'prototypes', 'tienda.yaml'), 'utf8'), before);
  });
});

test('ids are given when missing, and a copied page gets fresh ones', async () => {
  await withDir(async dir => {
    await createPrototype(dir, { title: 'Tienda', by: 'person' });
    const r = await applyOps(dir, 'tienda', [{ op: 'insert', parent: 'inicio', node: { type: 'button', text: 'Ver más' } as never }], { by: 'agent', did: 'x' });
    assert.ok(r.prototype.pages[0]!.children.some(n => n.id === 'button-ver-mas'));
    const copy = copyPage(r.prototype, 'inicio', 'inicio-b', 'Inicio B');
    assert.equal(copy.children.length, 2);
    assert.ok(copy.children.every(n => !['titulo', 'button-ver-mas'].includes(n.id)));
  });
});

test('render: pages are sections, clicks become data attributes, text is escaped', async () => {
  await withDir(async dir => {
    await createPrototype(dir, { title: 'A <b>', by: 'person' });
    const r = await applyOps(dir, 'a-b', [
      { op: 'insert', parent: 'inicio', node: { id: 'menu', type: 'stack', hidden: true, children: [{ id: 'item', type: 'link', text: 'Uno', on: { click: { back: true } } }] } },
      { op: 'insert', parent: 'inicio', node: { id: 'abrir', type: 'button', text: '☰', on: { click: { toggle: 'menu' } } } },
    ], { by: 'person', did: 'menú' });
    const html = renderPrototype(r.prototype);
    assert.match(html, /<title>A &lt;b&gt;<\/title>/);
    assert.match(html, /<section id="inicio" data-node="inicio" data-screen="Inicio" class="min-h-screen p-8">/);
    assert.match(html, /<div id="menu" data-node="menu" class="flex flex-col" hidden><a id="item" data-node="item" href="#" data-back>Uno<\/a><\/div>/);
    assert.match(html, /data-toggle="menu"/);
  });
});

test('the sitemap knows which prototype each page belongs to, its flows and where clicks lead; docs keep notes', async () => {
  await withDir(async dir => {
    await createPrototype(dir, { title: 'Tienda', group: 'Checkout', by: 'person' });
    await applyOps(dir, 'tienda', [
      { op: 'add_page', page: { id: 'pago', title: 'Pago', flow: 'Compra', children: [] } },
      { op: 'add_page', page: { id: 'huerfana', title: 'Huérfana', children: [] } },
      { op: 'insert', parent: 'inicio', node: { id: 'comprar', type: 'button', text: 'Comprar', on: { click: { go: 'pago' } } } },
    ], { by: 'agent', did: 'x' });
    const { prototypes } = await readSitemap(dir);
    assert.deepEqual(prototypes[0]!.flows, [{ name: '', pages: ['inicio', 'huerfana'] }, { name: 'Compra', pages: ['pago'] }]);
    const md = sitemapMarkdown(prototypes);
    assert.match(md, /## Tienda · Checkout/);
    assert.match(md, /\*\*Inicio\*\* `#inicio` → Pago/);
    assert.match(md, /\| Inicio \| Comprar `comprar` \| ir a \*\*Pago\*\* \|/);
    assert.match(md, /Ningún enlace lleva a: Huérfana/);
    const kept = mergeGenerated(mergeGenerated(undefined, 'Sitemap', 90, 'v1') + '\nMis notas.\n', 'Sitemap', 90, 'v2');
    assert.match(kept, /v2/);
    assert.doesNotMatch(kept, /v1/);
    assert.match(kept, /Mis notas\./);
    mkdirSync(join(dir, 'guide'), { recursive: true });
    writeFileSync(join(dir, 'guide', 'tokens.yaml'), STARTER_TOKENS);
    assert.equal(await writeDocs(dir), true);
    assert.match(readFileSync(join(dir, 'guide', '10-tokens.md'), 'utf8'), /bg-brand/);
    assert.equal(await writeDocs(dir), false, 'nothing changed, nothing written');
  });
});

test('the build renders HTML and compiles tokens and classes into CSS, only when they change', async () => {
  await withDir(async dir => {
    mkdirSync(join(dir, 'guide'), { recursive: true });
    writeFileSync(join(dir, 'guide', 'tokens.yaml'), STARTER_TOKENS);
    assert.match(themeCss({ colors: { brand: '#4f46e5', 'bad;': 'x' } }), /--color-brand: #4f46e5;/);
    await createPrototype(dir, { title: 'Tienda', by: 'person' });
    await applyOps(dir, 'tienda', [{ op: 'insert', parent: 'inicio', node: { id: 'cta', type: 'button', text: 'Ir', class: 'bg-brand rounded-card px-4' } }], { by: 'agent', did: 'x' });
    const first = await renderWorkspace(dir);
    assert.deepEqual(first.rendered, ['tienda']);
    assert.equal(first.cssChanged, true);
    const css = readFileSync(join(dir, 'dist', 'main.css'), 'utf8');
    assert.match(css, /--color-brand: #4f46e5/);
    assert.match(css, /\.bg-brand/);
    assert.match(css, /\.rounded-card/);
    assert.match(readFileSync(join(dir, 'dist', 'tienda.html'), 'utf8'), /data-node="cta"/);
    // Same classes: HTML again, no CSS.
    await applyOps(dir, 'tienda', [{ op: 'set', id: 'cta', fields: { text: 'Ir ya' } }], { by: 'agent', did: 'x' });
    assert.equal((await renderWorkspace(dir, ['tienda'])).cssChanged, false);
    await applyOps(dir, 'tienda', [{ op: 'set', id: 'cta', fields: { class: 'bg-brand rounded-card px-8' } }], { by: 'agent', did: 'x' });
    assert.equal((await renderWorkspace(dir, ['tienda'])).cssChanged, true);
  });
});

test('the agent reads a prototype without its history', async () => {
  await withDir(async dir => {
    const p = await createPrototype(dir, { title: 'Tienda', by: 'person' });
    assert.doesNotMatch(toYaml(p, { history: false }), /history/);
    assert.match(toYaml(p), /history/);
  });
});
