import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBash } from '../src/bash.ts';

test('classifyBash: pure read returns no intent and no paths', () => {
  const result = classifyBash('ls -la');
  assert.equal(result.intent, 'none');
  assert.equal(result.paths.length, 0);
});

test('classifyBash: redirect into a file is a redirect write', () => {
  const result = classifyBash('echo hello > /tmp/foo.txt');
  assert.equal(result.intent, 'redirect');
  assert.deepEqual(result.paths, ['/tmp/foo.txt']);
});

test('classifyBash: append redirect is a redirect', () => {
  const result = classifyBash('echo hello >> /tmp/foo.txt');
  assert.equal(result.intent, 'redirect');
  assert.deepEqual(result.paths, ['/tmp/foo.txt']);
});

test('classifyBash: sed -i is treated as a modify', () => {
  const result = classifyBash('sed -i "s/a/b/g" /tmp/foo.txt');
  assert.equal(result.intent, 'modify');
  assert.ok(result.paths.includes('/tmp/foo.txt'));
});

test('classifyBash: rm is destructive and includes the file', () => {
  const result = classifyBash('rm /tmp/foo.txt');
  assert.equal(result.intent, 'destructive');
  assert.ok(result.paths.includes('/tmp/foo.txt'));
});

test('classifyBash: cp with dest extracts destination only', () => {
  const result = classifyBash('cp /tmp/src.txt /tmp/dst.txt');
  assert.equal(result.intent, 'redirect');
  assert.ok(result.paths.includes('/tmp/dst.txt'));
  assert.ok(!result.paths.includes('/tmp/src.txt'));
});

test('classifyBash: piped commands extract the redirection target', () => {
  const result = classifyBash('cat /tmp/a.txt | grep foo > /tmp/b.txt');
  assert.equal(result.intent, 'redirect');
  assert.ok(result.paths.includes('/tmp/b.txt'));
});

test('classifyBash: chains capture multiple writes', () => {
  const result = classifyBash('echo a > /tmp/a.txt && echo b > /tmp/b.txt');
  assert.equal(result.intent, 'redirect');
  assert.deepEqual([...result.paths].sort(), ['/tmp/a.txt', '/tmp/b.txt']);
});
