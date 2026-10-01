import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { makeFakePi } from './host.ts';
import { DESIGNER_TYPE, DESIGNER_PROMPT, hasDesignerMessage, isDesignRequest } from '../src/designer.ts';

test('designer guidance is injected once on a design task, without changing the system prompt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-proto-designer-'));
  const pi = makeFakePi(cwd);
  const ctx = { cwd, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
  const start = pi.hooks.get('before_agent_start')![0]!;
  try {
    assert.equal(await start({ prompt: 'arregla una consulta SQL', systemPrompt: 'cached' }, ctx), undefined);
    const guidance = await start({ prompt: 'diseña el checkout', systemPrompt: 'cached' }, ctx) as any;
    assert.equal(guidance.message.customType, DESIGNER_TYPE);
    assert.equal(guidance.message.content, DESIGNER_PROMPT);
    assert.equal(guidance.message.display, false);
    assert.equal('systemPrompt' in guidance, false);
    assert.equal(await start({ prompt: 'proto: cambia el color', systemPrompt: 'cached' }, ctx), undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a restored session branch already carrying designer guidance is not injected again', async () => {
  const pi = makeFakePi('/private/tmp');
  const ctx = { cwd: '/private/tmp', sessionManager: { getBranch: () => [{ type: 'custom_message', customType: DESIGNER_TYPE, content: DESIGNER_PROMPT }] } } as unknown as ExtensionContext;
  assert.equal(hasDesignerMessage(ctx), true);
  assert.equal(hasDesignerMessage({ sessionManager: { getBranch: () => [{ type: 'custom_message', customType: DESIGNER_TYPE, content: 'older guidance' }] } } as unknown as ExtensionContext), false);
  assert.equal(await pi.hooks.get('before_agent_start')![0]!({ prompt: 'proto checkout' }, ctx), undefined);
  assert.equal(isDesignRequest('prototype the checkout'), true);
  assert.equal(isDesignRequest('design a screen'), true);
  assert.equal(isDesignRequest('design a database'), false);
});
