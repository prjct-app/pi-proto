import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { guard } from '../src/guard.ts';
import type { ProtoConfig } from '../src/config.ts';

const withTmp = async (fn: (root: string, protoDir: string) => Promise<void> | void): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'pi-proto-guard-'));
  const protoDir = join(root, 'proto');
  mkdirSync(protoDir, { recursive: true });
  try { await fn(root, protoDir); } finally { rmSync(root, { recursive: true, force: true }); }
};

const configFor = (root: string): ProtoConfig => ({
  schemaVersion: 1,
  project: { name: 'demo', projectId: 'p_demo', location: root },
  stack: 'plain', styling: 'plain', darkMode: 'media', viewports: [],
  ui: { paths: [join(root, 'app')], gate: 'all' },
  team: { protoRoles: ['ux'], portRoles: ['fe'] },
  allowWrite: [join(root, 'scripts')],
  sitemap: [],
  items: [
    { id: 'home', kind: 'screen', status: 'draft', targets: [join(root, 'app/index.html')] },
    { id: 'cta', kind: 'component', status: 'approved', targets: [join(root, 'app/components/cta.tsx')], approvedAt: 1, approvedBy: 'user' },
  ],
});

test('guard: no-op when mode is off (no config, no env)', async () => {
  await withTmp(async (root, protoDir) => {
    delete process.env.PI_PROTO_MODE;
    const result = await guard({
      toolName: 'edit',
      input: { path: join(root, 'app/index.html') },
      projectRoot: root,
      protoDir,
      config: undefined,
    });
    assert.equal(result, undefined);
  });
});

test('guard: blocks edits to unapproved UI files when mode is on', async () => {
  await withTmp(async (root, protoDir) => {
    process.env.PI_PROTO_MODE = '1';
    try {
      const result = await guard({
        toolName: 'edit',
        input: { path: join(root, 'app/index.html') },
        projectRoot: root,
        protoDir,
        config: configFor(root),
      });
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? '', /blocks write to/);
      assert.match(result?.reason ?? '', /home/);
    } finally { delete process.env.PI_PROTO_MODE; }
  });
});

test('guard: allows edits to approved UI files when mode is on', async () => {
  await withTmp(async (root, protoDir) => {
    process.env.PI_PROTO_MODE = '1';
    try {
      const result = await guard({
        toolName: 'edit',
        input: { path: join(root, 'app/components/cta.tsx') },
        projectRoot: root,
        protoDir,
        config: configFor(root),
      });
      assert.equal(result?.block, false);
    } finally { delete process.env.PI_PROTO_MODE; }
  });
});

test('guard: always allows writes inside the proto folder', async () => {
  await withTmp(async (root, protoDir) => {
    process.env.PI_PROTO_MODE = '1';
    try {
      const result = await guard({
        toolName: 'write',
        input: { path: join(protoDir, 'design.md') },
        projectRoot: root,
        protoDir,
        config: configFor(root),
      });
      assert.equal(result?.block, false);
    } finally { delete process.env.PI_PROTO_MODE; }
  });
});

test('guard: always allows writes inside allowWrite paths', async () => {
  await withTmp(async (root, protoDir) => {
    process.env.PI_PROTO_MODE = '1';
    try {
      const result = await guard({
        toolName: 'write',
        input: { path: join(root, 'scripts/seed.js') },
        projectRoot: root,
        protoDir,
        config: configFor(root),
      });
      assert.equal(result?.block, false);
    } finally { delete process.env.PI_PROTO_MODE; }
  });
});

test('guard: blocks bash redirects to unapproved UI files', async () => {
  await withTmp(async (root, protoDir) => {
    process.env.PI_PROTO_MODE = '1';
    try {
      const result = await guard({
        toolName: 'bash',
        input: { command: `echo hi > ${join(root, 'app/index.html')}` },
        projectRoot: root,
        protoDir,
        config: configFor(root),
      });
      assert.equal(result?.block, true);
    } finally { delete process.env.PI_PROTO_MODE; }
  });
});

test('guard: read tools are never blocked', async () => {
  await withTmp(async (root, protoDir) => {
    process.env.PI_PROTO_MODE = '1';
    try {
      const result = await guard({
        toolName: 'read',
        input: { path: join(root, 'app/index.html') },
        projectRoot: root,
        protoDir,
        config: configFor(root),
      });
      assert.equal(result, undefined);
    } finally { delete process.env.PI_PROTO_MODE; }
  });
});
