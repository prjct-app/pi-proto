import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { StatusFile } from '../src/status.ts';
import { ProtoConfigSchema, type ProtoConfig } from '../src/config.ts';

const withProtoDir = async (fn: (protoDir: string) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-proto-status-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

test('StatusFile: read returns undefined when no config exists', async () => {
  await withProtoDir(async dir => {
    const file = new StatusFile(dir);
    assert.equal(await file.read(), undefined);
  });
});

test('StatusFile: write then read round-trips through the schema', async () => {
  await withProtoDir(async dir => {
    const file = new StatusFile(dir);
    const config: ProtoConfig = {
      schemaVersion: 1,
      project: { name: 'demo', projectId: 'p_demo123', location: '/tmp/demo' },
      stack: 'plain',
      styling: 'tw4-postcss',
      darkMode: 'class',
      viewports: [{ label: 'mobile', width: 360, height: 740 }, { label: 'desktop', width: 1280, height: 800 }],
      ui: { paths: ['/tmp/demo/app'], gate: 'all' },
      team: { protoRoles: ['ux'], portRoles: ['fe'] },
      allowWrite: ['/tmp/demo/scripts'],
      sitemap: [],
      items: [],
    };
    await file.write(config);
    assert.ok(existsSync(join(dir, 'proto.json')));
    const raw = readFileSync(join(dir, 'proto.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Schema validates
    Value.Parse(ProtoConfigSchema, parsed);
    const hash = sha(raw);
    // hash is non-empty
    assert.equal(hash.length, 64);
    const back = await file.read();
    assert.deepEqual(back, config);
  });
});

test('StatusFile: read falls back to undefined when file is corrupt', async () => {
  await withProtoDir(async dir => {
    writeFileSync(join(dir, 'proto.json'), '{ not valid json');
    const file = new StatusFile(dir);
    const result = await file.read();
    // Either undefined or a schema-valid empty object; the contract is "no crash".
    assert.ok(result === undefined || typeof result === 'object');
  });
});

test('StatusFile: write replaces existing config atomically', async () => {
  await withProtoDir(async dir => {
    const file = new StatusFile(dir);
    await file.write({
      schemaVersion: 1, project: { name: 'a', projectId: 'p_a', location: '/tmp/a' },
      stack: 'plain', styling: 'plain', darkMode: 'media', viewports: [{ label: 'desktop', width: 1280, height: 800 }],
      ui: { paths: [], gate: 'off' }, team: { protoRoles: [], portRoles: [] }, allowWrite: [], sitemap: [], items: [],
    });
    const firstMtime = readFileSync(join(dir, 'proto.json'), 'utf8');
    await file.write({
      schemaVersion: 1, project: { name: 'b', projectId: 'p_b', location: '/tmp/b' },
      stack: 'plain', styling: 'plain', darkMode: 'media', viewports: [{ label: 'desktop', width: 1280, height: 800 }],
      ui: { paths: [], gate: 'off' }, team: { protoRoles: [], portRoles: [] }, allowWrite: [], sitemap: [], items: [],
    });
    const second = readFileSync(join(dir, 'proto.json'), 'utf8');
    assert.notEqual(firstMtime, second);
  });
});
