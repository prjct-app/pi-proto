import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../src/spec/init.ts';
import { ProjectHub } from '../src/daemon/hub.ts';
import { readPrototype, fileOf } from '../src/spec/store.ts';
import { readTokens, tokensProblems, themeCss } from '../src/spec/tokens.ts';

test('rapid edits produce one build each; deferred generated docs do not rebuild the whole workspace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-proto-responsive-'));
  const folder = await mkdtemp(join(tmpdir(), 'pi-proto-responsive-project-'));
  const old = process.env['PI_PROTO_HOME'];
  process.env['PI_PROTO_HOME'] = home;
  const { project } = await initWorkspace(folder, 'person', { artifact: 'prototype', starter: true });
  const hub = new ProjectHub(home, project.projectId);
  const events: string[] = [];
  hub.publish = event => { events.push(event); };
  try {
    assert.equal(await hub.start(), true);
    events.length = 0;
    await hub.apply('inicio', [{ op: 'set', id: 'titulo', fields: { text: 'Primero' } }], { by: 'agent', did: 'uno' });
    await hub.apply('inicio', [{ op: 'set', id: 'titulo', fields: { text: 'Segundo' } }], { by: 'agent', did: 'dos' });
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(events.filter(event => event === 'built').length, 2, events.join(', '));
    assert.equal(events.filter(event => event === 'patch').length, 2);
    assert.match(await readFile(join(project.protoDir, 'guide', '95-handoff.md'), 'utf8'), /v3/);
    const html = await readFile(join(project.protoDir, 'dist', 'inicio.html'), 'utf8');
    const tokens = await readFile(join(project.protoDir, 'guide', 'tokens.yaml'), 'utf8');
    await writeFile(join(project.protoDir, 'guide', 'tokens.yaml'), tokens.replaceAll('bg-brand', 'this-utility-is-not-defined'));
    await assert.rejects(hub.apply('inicio', [{ op: 'set', id: 'titulo', fields: { text: 'Guardado' } }], { by: 'agent', did: 'fallo' }), /saved as inicio v4.*could not render/s);
    assert.equal((await readPrototype(project.protoDir, 'inicio')).version, 4);
    assert.equal(await readFile(join(project.protoDir, 'dist', 'inicio.html'), 'utf8'), html);
  } finally {
    await hub.stop();
    if (old === undefined) delete process.env['PI_PROTO_HOME']; else process.env['PI_PROTO_HOME'] = old;
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});

test('cached YAML remains independent and detects external changes; text tokens are not silently discarded', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-proto-cache-'));
  const folder = await mkdtemp(join(tmpdir(), 'pi-proto-cache-project-'));
  const old = process.env['PI_PROTO_HOME'];
  process.env['PI_PROTO_HOME'] = home;
  try {
    const { project } = await initWorkspace(folder, 'person', { artifact: 'prototype', starter: true });
    const first = await readPrototype(project.protoDir, 'inicio');
    first.title = 'Mutated by caller';
    assert.notEqual((await readPrototype(project.protoDir, 'inicio')).title, first.title);
    const source = await readFile(fileOf(project.protoDir, 'inicio'), 'utf8');
    await writeFile(fileOf(project.protoDir, 'inicio'), source.replace('title: Inicio', 'title: Otro'));
    assert.equal((await readPrototype(project.protoDir, 'inicio')).title, 'Otro');
    await writeFile(join(project.protoDir, 'guide', 'tokens.yaml'), 'text:\n  small: "13px"\nradius:\n  pill: "999px"\n');
    const css = themeCss(await readTokens(project.protoDir));
    assert.match(css, /--text-small: 13px/);
    assert.match(css, /--radius-pill: 999px/);
    assert.match(tokensProblems({ typoGroup: { small: '13px' } }).join(), /unsupported token group/);
  } finally {
    if (old === undefined) delete process.env['PI_PROTO_HOME']; else process.env['PI_PROTO_HOME'] = old;
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});
