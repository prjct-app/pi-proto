import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understand, type Jev } from '../src/daemon/understand.ts';
import type { Prototype } from '../src/spec/schema.ts';

const prototype = (id: string): Prototype => ({ proto: 1, id, title: id, version: 1, pages: [
  { id: 'inicio', title: 'Inicio', children: [{ id: 'titulo', type: 'text', text: 'Inicio' }] },
  { id: 'pago', title: 'Pago', children: [{ id: 'pago-titulo', type: 'text', text: 'Pagar' }] },
] });
const choice = (value: string, confidence = 0.95) => ({ type: 'choice' as const, choice: value, confidence });

test('one Jev request qualifies ids across prototypes and can target a different page', async () => {
  const calls: unknown[] = [];
  const jev: Jev = async (state, questions) => {
    calls.push(state);
    assert.ok('a/inicio/titulo' in (questions['node'] as any).criteria);
    assert.ok('b/inicio/titulo' in (questions['node'] as any).criteria);
    return { intent: choice('change'), page: choice('b/pago'), node: choice('b/pago/pago-titulo') };
  };
  const result = await understand(jev, { text: 'el título de pago más pequeño', prototypes: [prototype('a'), prototype('b')], current: { prototype: 'a', page: 'inicio' }, selected: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(result?.node, { id: 'pago-titulo', label: 'Pagar', prototype: 'b', page: 'pago' });
  assert.equal(result?.page?.prototype, 'b');
});

test('explicit selection suppresses guessing and mismatched page/node results are dropped', async () => {
  const p = prototype('a');
  const selected: Jev = async (_state, questions) => {
    assert.equal(questions['node'], undefined);
    return { intent: choice('change'), node: choice('a/inicio/titulo') };
  };
  assert.equal((await understand(selected, { text: 'más pequeño', prototypes: [p], current: { prototype: 'a', page: 'inicio' }, selected: true }))?.node, undefined);
  const mismatch: Jev = async () => ({ intent: choice('change'), page: choice('a/pago'), node: choice('a/inicio/titulo') });
  assert.equal((await understand(mismatch, { text: 'el título de pago', prototypes: [p], current: { prototype: 'a', page: 'inicio' }, selected: false }))?.node, undefined);
});

test('invalid choices, nonfinite confidence and long briefs do not drive actions', async () => {
  for (const answer of [choice('toString'), choice('navigate', NaN), choice('navigate', Infinity), choice('undo', 2), choice('undo', -1)]) {
    assert.equal(await understand(async () => ({ intent: answer }), { text: 'abre pago', prototypes: [prototype('a')], selected: false }), undefined);
  }
  const never: Jev = async () => { throw new Error('must not run'); };
  assert.equal(await understand(never, { text: 'a'.repeat(1001), prototypes: [], selected: false }), undefined);
  assert.equal(await understand(never, { text: '  ', prototypes: [], selected: false }), undefined);
});
