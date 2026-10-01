import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProject, projectIdFrom, checkoutIdFrom, memoryHomeFor, componentPath } from '../src/identity.ts';

const withTmpHome = (fn: (home: string) => void | Promise<void>): Promise<void> => {
  const home = mkdtempSync(join(tmpdir(), 'pi-proto-home-'));
  const previous = process.env.PI_PROTO_HOME;
  process.env.PI_PROTO_HOME = home;
  return Promise.resolve(fn(home)).finally(() => {
    if (previous === undefined) delete process.env.PI_PROTO_HOME;
    else process.env.PI_PROTO_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
};

const withTmpCwd = (fn: (cwd: string) => Promise<void> | void): Promise<void> => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-proto-cwd-'));
  return Promise.resolve(fn(cwd)).finally(() => rmSync(cwd, { recursive: true, force: true }));
};

test('projectIdFrom and checkoutIdFrom are stable and 12 hex chars', () => {
  const id = projectIdFrom('/Users/jj/Apps/ese');
  assert.match(id, /^p_[a-f0-9]{12}$/u);
  const co = checkoutIdFrom('/Users/jj/Apps/ese');
  assert.match(co, /^co_[a-f0-9]{12}$/u);
  assert.notEqual(id, co);
});

test('memoryHomeFor honors PI_PROTO_HOME', async () => {
  await withTmpHome(home => {
    assert.equal(memoryHomeFor(), home);
  });
});

test('componentPath under project scope lands at $home/<projectId>/<component>', async () => {
  await withTmpHome(home => {
    const out = componentPath(home, 'project', 'p_abc123', 'proto');
    assert.equal(out, resolve(home, 'p_abc123', 'proto'));
  });
});

test('resolveProject falls back to derived id when no binding exists', async () => {
  await withTmpCwd(async cwd => {
    const { projectId, checkoutId, location } = await resolveProject(cwd);
    assert.equal(location, realpathSync(cwd));
    assert.match(projectId, /^p_[a-f0-9]{12}$/u);
    assert.match(checkoutId, /^co_[a-f0-9]{12}$/u);
  });
});

test('resolveProject honors a signed binding in identity/index.json', async () => {
  await withTmpCwd(async cwd => {
    await withTmpHome(async home => {
      const cfgDir = join(cwd, '.prjct');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, 'prjct.config.json'), JSON.stringify({ projectId: 'p_signed123' }));
      const idDir = join(home, 'identity');
      mkdirSync(idDir, { recursive: true });
      const canonicalCwd = realpathSync(cwd);
      const payload = { bindings: [{ location: canonicalCwd, projectId: 'p_signed123' }] };
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      writeFileSync(join(idDir, 'index.json'), JSON.stringify({ schemaVersion: 1, revision: 1, contentHash: hash, payload }));
      const result = await resolveProject(cwd, home);
      assert.equal(result.projectId, 'p_signed123');
    });
  });
});

test('resolveProject ignores an unsigned binding (id present but not in identity index)', async () => {
  await withTmpCwd(async cwd => {
    await withTmpHome(async home => {
      const cfgDir = join(cwd, '.prjct');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, 'prjct.config.json'), JSON.stringify({ projectId: 'p_unsigned' }));
      // No identity index
      assert.ok(!existsSync(join(home, 'identity', 'index.json')));
      const result = await resolveProject(cwd, home);
      assert.notEqual(result.projectId, 'p_unsigned');
      assert.match(result.projectId, /^p_[a-f0-9]{12}$/u);
    });
  });
});
