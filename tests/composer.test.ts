import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAsk } from '../src/daemon/composer.ts';
import { ProjectHub } from '../src/daemon/hub.ts';
import { applyOps, createPrototype, readPrototype } from '../src/spec/store.ts';
import { STARTER_TOKENS } from '../src/spec/tokens.ts';
import { userContent } from '../src/session-bridge.ts';

const withHub = async (fn: (hub: ProjectHub, events: Array<{ event: string; data: any }>, asks: any[]) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-proto-composer-'));
  const hub = new ProjectHub(dir, 'p_abcdef123456');
  const events: Array<{ event: string; data: any }> = [];
  const asks: any[] = [];
  hub.publish = (event, data) => { events.push({ event, data }); };
  hub.toSession = (event, data) => { asks.push({ event, data }); return true; };
  try {
    await mkdir(join(hub.protoDir, 'guide'), { recursive: true });
    await writeFile(join(hub.protoDir, 'guide', 'tokens.yaml'), STARTER_TOKENS);
    await createPrototype(hub.protoDir, { title: 'Inicio', by: 'person' });
    await applyOps(hub.protoDir, 'inicio', [{ op: 'add_page', page: { id: 'pago', title: 'Pago', children: [{ id: 'pago-titulo', type: 'text', text: 'Pagar' }] } }], { by: 'agent', did: 'agregar pago' });
    await fn(hub, events, asks);
  } finally { await hub.stop(); await rm(dir, { recursive: true, force: true }); }
};

test('exact navigation and undo remain local and recoverable', async () => withHub(async (hub, events, asks) => {
  hub.toSession = () => false;
  assert.deepEqual((await handleAsk(hub, { text: 'abre pago' })).body, { ok: true, handled: 'navigate' });
  assert.equal(events.find(e => e.event === 'navigate')?.data.page, 'pago');
  assert.equal(asks.length, 0);
  assert.equal((await handleAsk(hub, { text: 'deshaz', target: { prototype: 'inicio', page: 'inicio' } })).body.handled, 'undo');
  const p = await readPrototype(hub.protoDir, 'inicio');
  assert.equal(p.version, 3);
  assert.deepEqual(p.pages.map(pg => pg.id), ['inicio']);
}));

test('selected evidence is forwarded whole and per-tab selection beats global viewing', async () => withHub(async (hub, events, asks) => {
  hub.viewing = { prototype: 'other-tab', page: 'other', at: 0 };
  const text = 'el título de pago más pequeño';
  const target = { prototype: 'inicio', page: 'pago', node: 'pago-titulo' };
  const result = await handleAsk(hub, { text, target });
  assert.equal(result.status, 202);
  assert.equal(asks[0].data.text, text);
  assert.equal(asks[0].data.target.node, 'pago-titulo');
  assert.equal(asks[0].data.context.version, 2);
  assert.match(asks[0].data.context.yaml, /text: Pagar/);
  assert.equal(events.some(e => e.event === 'navigate'), false);
  const content = userContent(text, asks[0].data.target, [], asks[0].data.context);
  assert.match((content[1] as any).text, /v2.*\nCurrent prototype data/);
}));

test('legacy inference requests, ambiguous edits and images go directly to Pi', async () => withHub(async (hub, events, asks) => {
  const target = { prototype: 'inicio', page: 'inicio' };
  for (const text of ['el título de pago más pequeño', 'todos los títulos más pequeños', 'abre pago y cambia el botón']) {
    assert.equal((await handleAsk(hub, { text, target, understand: true })).status, 202);
    assert.equal(asks.at(-1).data.text, text);
    assert.equal(asks.at(-1).data.target.node, undefined);
    assert.equal(asks.at(-1).data.understood, undefined);
  }
  const image = { mimeType: 'image/png', data: 'AAAA' };
  await handleAsk(hub, { text: 'abre pago', images: [image] });
  assert.deepEqual(asks.at(-1).data.images, [image]);
  assert.equal(events.some(e => e.event === 'navigate'), false);
  hub.toSession = () => false;
  assert.equal((await handleAsk(hub, { text: 'change the title' })).status, 409);
}));

test('a working agent prevents local undo; ambiguous undo does not guess a version', async () => withHub(async (hub, _events, asks) => {
  const target = { prototype: 'inicio', page: 'inicio' };
  hub.sessionSummary = () => ({ label: 'Pi', agent: { state: 'working' } });
  assert.equal((await handleAsk(hub, { text: 'deshaz', target })).status, 202);
  hub.sessionSummary = () => undefined;
  assert.equal((await handleAsk(hub, { text: 'revierte lo anterior', understand: true, target })).status, 202);
  assert.equal((await readPrototype(hub.protoDir, 'inicio')).version, 2);
  assert.equal(asks.length, 2);
}));
