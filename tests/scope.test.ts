import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { taskScope, scopeViolation, scopeFileViolation } from '../src/scope.ts';
import { initWorkspace } from '../src/spec/init.ts';
import { createPrototype, listPrototypes, readPrototype } from '../src/spec/store.ts';
import { readTokens } from '../src/spec/tokens.ts';
import { readDesign, writeDesign, writeTokens } from '../src/design-guide.ts';
import { DESIGNER_PROMPT, DESIGNER_TYPE } from '../src/designer.ts';
import { handoffMarkdown, writeDocs } from '../src/docs.ts';
import { makeFakePi } from './host.ts';

test('narrow artifact requests do not authorize prototyping, including explicit negatives and context prefixes', () => {
  for (const text of ['genera los tokens', 'quiero que generes los tokens de estas referencias', 'necesito los tokens, nada más', 'saca los tokens de la referencia', 'extrae los tokens del prototipo actual', 'genera tokens, no prototipes', 'solo tokens', '[storybook · prototype home › page inicio]\ngenera los tokens', 'generate design tokens from the current prototype']) assert.equal(taskScope(text), 'tokens', text);
  for (const text of ['hazme el documento de diseño', 'documenta la línea de diseño', '[prototype · guide 01-vision]\nnalaiza el repo y dame las guias de diseño']) assert.equal(taskScope(text), 'guide', text);
  assert.equal(taskScope('[prototype task: tokens]\n[prototype · page inicio]\nusa la referencia de esta pantalla'), 'tokens');
  assert.equal(taskScope('genera el documento de diseño sin crear pantallas'), 'guide');
  assert.equal(taskScope('genera tokens y crea el prototipo'), undefined);
  assert.equal(taskScope('genera tokens y prototipa el flujo'), undefined);
  assert.equal(taskScope('genera tokens y escribe el documento'), 'foundation');
  assert.equal(taskScope('cambia el título'), undefined);
  assert.match(scopeViolation('tokens', 'proto_edit', {})!, /not requested/);
  assert.match(scopeViolation('guide', 'proto_init', { artifact: 'prototype' })!, /not requested/);
  assert.equal(scopeViolation('tokens', 'proto_read', {}), undefined);
  assert.equal(scopeFileViolation('tokens', '/tmp/studio.tokens.json', ''), undefined);
  assert.match(scopeFileViolation('tokens', '/tmp/page.tsx', '')!, /expand/);
});

test('native tool guard stops an agent after tokens and resets when the user requests screens', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-proto-scope-'));
  const pi = makeFakePi(folder);
  const ctx = { cwd: folder, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
  const start = pi.hooks.get('before_agent_start')![0]!;
  const tool = pi.hooks.get('tool_call')![0]!;
  try {
    await start({ prompt: 'genera los tokens' }, ctx);
    for (const toolName of ['proto_create', 'proto_edit']) assert.equal((await tool({ toolName, input: {} }, ctx) as any).block, true);
    assert.equal((await tool({ toolName: 'write', input: { path: 'src/app/page.tsx' } }, ctx) as any).block, true);
    assert.equal(await tool({ toolName: 'read', input: { path: 'reference.png' } }, ctx), undefined);
    await start({ prompt: 'ahora crea el prototipo' }, ctx);
    assert.equal(await tool({ toolName: 'proto_create', input: {} }, ctx), undefined);
    const old = { role: 'custom', customType: DESIGNER_TYPE, content: 'Build the first screen immediately.' };
    const current = { role: 'custom', customType: DESIGNER_TYPE, content: DESIGNER_PROMPT };
    const user = { role: 'user', content: 'genera tokens' };
    const filtered = await pi.hooks.get('context')![0]!({ messages: [old, user, current, current] }, ctx) as any;
    assert.deepEqual(filtered.messages.filter((m: any) => m.customType !== 'proto-context'), [user, current]);
    await pi.hooks.get('agent_end')![0]!({ messages: [] }, ctx);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('workspace/tokens/design writes create no prototype, merge values and preserve existing screens', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-proto-artifact-home-'));
  const folder = await mkdtemp(join(tmpdir(), 'pi-proto-artifact-project-'));
  const old = process.env['PI_PROTO_HOME']; process.env['PI_PROTO_HOME'] = home;
  try {
    const { project } = await initWorkspace(folder, 'agent', { artifact: 'tokens' });
    assert.deepEqual(await listPrototypes(project.protoDir), []);
    assert.deepEqual(await readTokens(project.protoDir), {}, 'no invented purple brand or default font');
    await writeTokens(project.protoDir, { colors: { brand: '#eb5600', paper: '#faf7f5' } });
    await writeTokens(project.protoDir, { colors: { brand: '#b34300' }, radius: { control: '8px' } });
    assert.equal((await readTokens(project.protoDir)).colors!.paper, '#faf7f5');
    const references = [{ source: 'reference.png', role: 'target' as const, notes: 'Editorial framing and warm paper, not a generic login card.' }];
    await writeDesign(project.protoDir, '# Diseño\n\n## Alcance\nSolo documento.\n\n## Decisiones\nRetícula editorial, marco fino y tipografía protagonista. Tokens: `guide/tokens.yaml`.', references);
    await writeDocs(project.protoDir);
    assert.deepEqual(await listPrototypes(project.protoDir), []);
    assert.match((await readDesign(project.protoDir))!, /target.*reference.png/);
    const before = await readDesign(project.protoDir);
    await assert.rejects(writeDesign(project.protoDir, 'duplicated '.repeat(600), references), /limit 500/);
    assert.equal(await readDesign(project.protoDir), before);
    await createPrototype(project.protoDir, { title: 'Existente', by: 'person' });
    const p = await readPrototype(project.protoDir, 'existente');
    await initWorkspace(folder, 'agent', { artifact: 'guide' });
    await writeTokens(project.protoDir, { colors: { brand: '#eb5600' } });
    assert.deepEqual(await readPrototype(project.protoDir, 'existente'), p);
    const index = await readFile(join(project.protoDir, 'guide', '95-handoff.md'), 'utf8');
    assert.match(index, /00-design/);
    assert.doesNotMatch(index, /Retícula editorial/);
  } finally {
    if (old === undefined) delete process.env['PI_PROTO_HOME']; else process.env['PI_PROTO_HOME'] = old;
    await rm(home, { recursive: true, force: true }); await rm(folder, { recursive: true, force: true });
  }
});

test('Entrega remains a compact index even with huge authored guides and many findings', () => {
  const markdown = handoffMarkdown([], { colors: { brand: '#eb5600' } }, [{ title: 'Diseño', slug: '00-design', markdown: 'Long duplicated prose '.repeat(5000) }], [], []);
  assert.ok(markdown.split(/\s+/).length < 200);
  assert.doesNotMatch(markdown, /Long duplicated prose|#eb5600/);
  assert.ok(DESIGNER_PROMPT.split(/\s+/).length < 350);
});
