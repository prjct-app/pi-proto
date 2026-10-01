import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { projectContext, CONTEXT_LIMIT } from '../src/project-context.ts';
import { designMemory } from '../src/memory-context.ts';
import { RunBudget } from '../src/run-budget.ts';
import { makeFakePi } from './host.ts';
import { callTool } from '../src/daemon/mcp.ts';
import { writeDocs } from '../src/docs.ts';

test('one read-only inventory finds nested frontend, actual UI libraries and bounded source candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proto-context-'));
  const frontend = join(root, 'site-fe'); const protoDir = join(root, 'proto');
  const project = { location: root, protoDir, projectId: 'p_abcdef123456', checkoutId: 'co_fixture' };
  try {
    await mkdir(join(frontend, 'src', 'app'), { recursive: true });
    await mkdir(join(frontend, 'src', 'components'), { recursive: true });
    await writeFile(join(frontend, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0', '@heroui/react': '2.8.0', 'lucide-react': '0.500.0' } }));
    await writeFile(join(frontend, 'src', 'app', 'globals.css'), ':root { --brand: #eb5600; --surface: #faf7f5; }');
    await writeFile(join(frontend, 'src', 'components', 'Button.tsx'), 'throw new Error("source must not be executed");');
    const before = await readdir(root);
    const cold = await projectContext(project);
    assert.match(cold.text, /Frontend: site-fe/);
    assert.match(cold.text, /@heroui\/react@2.8.0.*resolution not verified/);
    assert.match(cold.text, /lucide-react/);
    assert.match(cold.text, /src\/components\/Button.tsx/);
    assert.match(cold.text, /--brand: #eb5600/);
    assert.ok(cold.text.length <= CONTEXT_LIMIT);
    assert.deepEqual(await readdir(root), before, 'read does not scaffold a design or prototype');
    assert.equal((await projectContext(project)).cached, true);
    await writeFile(join(frontend, 'src', 'app', 'globals.css'), ':root { --brand: #0055aa; }');
    const changed = await projectContext(project);
    assert.equal(changed.cached, false); assert.match(changed.text, /#0055aa/); assert.doesNotMatch(changed.text, /#eb5600/);
    await assert.rejects(projectContext(project, { frontend: '../outside' }), /inside this project/);
    const mcp = await callTool({ origin: 'http://unused', hub: async () => { throw new Error('inventory must not start a hub/build'); } }, 'proto_context', { project: root });
    assert.match(JSON.stringify(mcp), /@heroui/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pi-memory bridge uses supported worker view once, is bounded and never creates its own engine', async () => {
  const key = Symbol.for('prjct.memory'); const space = globalThis as any; const previous = space[key];
  const seen: any[] = [];
  try {
    delete space[key]; assert.equal((await designMemory('new page')).status, 'unavailable');
    space[key] = { childView: async (request: any) => { seen.push(request); return { text: '<project_memory>Keep the editorial frame. No generic login card.</project_memory>' }; } };
    const result = await designMemory('new internal page');
    assert.equal(result.status, 'available'); assert.match(result.text, /editorial frame/);
    assert.equal(seen.length, 1); assert.equal(seen[0].role, 'worker'); assert.equal(seen[0].maxBytes, 1500);
    space[key] = { childView: async () => new Promise(() => {}) };
    assert.equal((await designMemory('design', 10)).status, 'timeout');
  } finally { space[key] = previous; }
});

test('request budget counts actual model usage separately from cached input and tool executions', () => {
  const run = new RunBudget({ seconds: 180, calls: 12, tools: 24, output: 16_000 });
  run.message({ input: 1000, output: 250, cacheRead: 8000 });
  assert.deepEqual(run.usage, { calls: 1, tools: 0, input: 1000, output: 250, cacheRead: 8000 });
  assert.equal(run.reason(), undefined);
  run.usage.tools = 24; assert.match(run.reason()!, /tool-call/);
  run.usage.tools = 0; assert.match(run.reason(run.startedAt + 180_000)!, /time/);
});

test('a design request receives one replaceable context snapshot and cannot run a 64-call shell loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proto-run-'));
  const pi = makeFakePi(root); const aborted = { count: 0 };
  const ctx = { cwd: root, sessionManager: { getBranch: () => [] }, abort: () => { aborted.count += 1; } } as unknown as ExtensionContext;
  try {
    await pi.hooks.get('before_agent_start')![0]!({ prompt: 'analiza el repo y dame las guias de diseño' }, ctx);
    const contextual = await pi.hooks.get('context')![0]!({ messages: [{ role: 'custom', customType: 'proto-context', content: 'obsolete', display: false, timestamp: 1 }] }, ctx) as any;
    assert.equal(contextual.messages.length, 1); assert.match(contextual.messages[0].content, /Project memory: unavailable/);
    for (const _ of Array.from({ length: 24 })) await pi.hooks.get('tool_execution_start')![0]!({ toolName: 'bash', args: {} }, ctx);
    const blocked = await pi.hooks.get('tool_call')![0]!({ toolName: 'bash', input: { command: 'rg design src' } }, ctx) as any;
    assert.equal(blocked.block, true); assert.match(blocked.reason, /24 tool-call/); assert.equal(aborted.count, 1);
    await pi.hooks.get('agent_end')![0]!({ messages: [] }, ctx);
    await pi.hooks.get('before_agent_start')![0]!({ prompt: 'fix a SQL query' }, ctx);
    assert.equal(await pi.hooks.get('tool_call')![0]!({ toolName: 'bash', input: { command: 'rg query src' } }, ctx), undefined, 'unrelated work is not subject to Prototype budgets');
  } finally { await pi.hooks.get('session_shutdown')![0]!({}, ctx); await rm(root, { recursive: true, force: true }); }
});

test('a framework-neutral guide does not generate an empty component catalogue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proto-no-catalogue-'));
  try {
    await mkdir(join(root, 'guide')); await mkdir(join(root, 'prototypes')); await writeFile(join(root, 'guide', 'tokens.yaml'), '{}\n');
    await writeDocs(root);
    assert.ok(!(await readdir(join(root, 'guide'))).includes('20-components.md'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
