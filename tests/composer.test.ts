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
import type { Jev } from '../src/daemon/understand.ts';

const choice = (value: string, confidence = 0.95) => ({ type: 'choice' as const, choice: value, confidence });
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
  } finally { hub.stop(); await rm(dir, { recursive: true, force: true }); }
};

test('navigation and undo work without Pi, and undo remains a recoverable version', async () => withHub(async (hub, events, asks) => {
  hub.toSession = () => false;
  const navigate: Jev = async () => ({ intent: choice('navigate'), page: choice('inicio/pago') });
  assert.deepEqual((await handleAsk(hub, { text: 'abre pago' }, async () => navigate)).body, { ok: true, handled: 'navigate' });
  assert.equal(events.find(e => e.event === 'navigate')?.data.page, 'pago');
  assert.equal(asks.length, 0);
  const undo: Jev = async () => ({ intent: choice('undo') });
  const target = { prototype: 'inicio', page: 'inicio' };
  assert.equal((await handleAsk(hub, { text: 'deshaz', target }, async () => undo)).body.handled, 'undo');
  const p = await readPrototype(hub.protoDir, 'inicio');
  assert.equal(p.version, 3);
  assert.deepEqual(p.pages.map(pg => pg.id), ['inicio']);
  assert.match(p.history!.at(-1)!.did, /deshacer/);
}));

test('an inferred element reaches Pi as versioned YAML; per-tab context beats global viewing', async () => withHub(async (hub, events, asks) => {
  hub.viewing = { prototype: 'other-tab', page: 'other', at: 0 };
  const jev: Jev = async () => ({ intent: choice('change'), page: choice('inicio/pago'), node: choice('inicio/pago/pago-titulo') });
  const result = await handleAsk(hub, { text: 'el título de pago más pequeño', understand: true, target: { prototype: 'inicio', page: 'inicio' } }, async () => jev);
  assert.equal(result.status, 202);
  assert.equal(asks[0].data.target.node, 'pago-titulo');
  assert.equal(asks[0].data.viewing.prototype, 'inicio');
  assert.equal(asks[0].data.context.version, 2);
  assert.match(asks[0].data.context.yaml, /text: Pagar/);
  assert.equal(events.find(e => e.event === 'navigate')?.data.node, 'pago-titulo');
  const content = userContent('más pequeño', asks[0].data.target, [], asks[0].data.context);
  assert.match((content[1] as any).text, /v2.*\nCurrent prototype data/);
}));

test('explicit selections are respected, and system changes are not focused on a guessed node', async () => withHub(async (hub, events, asks) => {
  const selected: Jev = async (_state, questions) => {
    assert.equal(questions['node'], undefined);
    return { intent: choice('change') };
  };
  await handleAsk(hub, { text: 'más pequeño', understand: true, target: { prototype: 'inicio', page: 'inicio', node: 'titulo' } }, async () => selected);
  assert.equal(asks[0].data.target.node, 'titulo');
  assert.match(asks[0].data.context.yaml, /id: titulo/);
  const system: Jev = async () => ({ intent: choice('system'), node: choice('inicio/inicio/titulo') });
  await handleAsk(hub, { text: 'todos los títulos más pequeños', understand: true, target: { prototype: 'inicio', page: 'inicio' } }, async () => system);
  assert.equal(asks[1].data.target.node, undefined);
  assert.equal(events.some(e => e.event === 'navigate'), false);
}));

test('missing keys, errors, weak confidence, images and a hung credential lookup fall back to Pi', async () => withHub(async (hub, events, asks) => {
  const text = 'abre el pago';
  const cases = [
    async () => undefined,
    async () => (async () => { throw new Error('offline'); }) as Jev,
    async () => (async () => ({ intent: choice('navigate', 0.2), page: choice('inicio/pago') })) as Jev,
    () => new Promise<Jev | undefined>(() => {}),
  ];
  for (const connect of cases) {
    assert.equal((await handleAsk(hub, { text, understand: true }, connect, 20)).status, 202);
    assert.equal(asks.at(-1).data.text, text);
  }
  const image = { mimeType: 'image/png', data: 'AAAA' };
  await handleAsk(hub, { text, images: [image] }, async () => { throw new Error('should not classify images'); });
  assert.deepEqual(asks.at(-1).data.images, [image]);
  assert.equal(events.some(e => e.event === 'navigate'), false);
  hub.toSession = () => false;
  assert.equal((await handleAsk(hub, { text }, async () => undefined)).status, 409);
}));

test('an agent working or an edit during classification prevents automatic undo', async () => withHub(async (hub, _events, asks) => {
  const target = { prototype: 'inicio', page: 'inicio' };
  const undo: Jev = async () => ({ intent: choice('undo') });
  hub.sessionSummary = () => ({ label: 'Pi', agent: { state: 'working' } });
  assert.equal((await handleAsk(hub, { text: 'deshaz', target }, async () => undo)).status, 202);
  assert.equal((await readPrototype(hub.protoDir, 'inicio')).version, 2);
  hub.sessionSummary = () => undefined;
  const changing: Jev = async () => {
    await applyOps(hub.protoDir, 'inicio', [{ op: 'set', id: 'titulo', fields: { text: 'Nuevo' } }], { by: 'agent', did: 'concurrente' });
    return { intent: choice('undo') };
  };
  assert.equal((await handleAsk(hub, { text: 'revierte lo anterior', understand: true, target }, async () => changing)).status, 202);
  assert.equal((await readPrototype(hub.protoDir, 'inicio')).version, 3);
  assert.equal(asks.length, 2);
}));

test('normal edits and exact navigation never wait for credentials or a classifier', async () => withHub(async (hub, _events, asks) => {
  const connect = async (): Promise<Jev | undefined> => { assert.fail('normal composer must not call JEV'); };
  const start = performance.now();
  assert.equal((await handleAsk(hub, { text: 'cambia el título', target: { prototype: 'inicio', page: 'inicio', node: 'titulo' } }, connect)).status, 202);
  assert.match(asks[0].data.context.yaml, /id: titulo/);
  assert.equal((await handleAsk(hub, { text: 'muéstrame la página Pago' }, connect)).body.handled, 'navigate');
  assert.ok(performance.now() - start < 500, 'local forwarding should not consume the old 1500 ms classification budget');
  assert.equal((await handleAsk(hub, { text: 'abre pago y cambia el botón' }, connect)).status, 202);
}));
