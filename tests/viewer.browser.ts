import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import YAML from 'yaml';
import { initWorkspace } from '../src/spec/init.ts';
import { readTokens } from '../src/spec/tokens.ts';
import { startServer } from '../src/daemon/server.ts';


test('the browser forwards selections immediately, navigates/undoes without Pi and works on mobile', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-proto-browser-'));
  const folder = await mkdtemp(join(tmpdir(), 'pi-proto-browser-project-'));
  const previousHome = process.env['PI_PROTO_HOME'];
  process.env['PI_PROTO_HOME'] = home;
  const browser = await chromium.launch({ headless: true });
  const server = await startServer({ home, port: 0, viewer: resolve('viewer/dist') });
  const controller = new AbortController();
  try {
    await writeFile(join(folder, 'package.json'), '{"name":"browser-fixture"}');
    const { project } = await initWorkspace(folder, 'person', { artifact: 'prototype', starter: true });
    const base = `${server.url}/${project.projectId}/`;
    const get = async (path: string) => fetch(base + path);
    const post = async (path: string, body: unknown) => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.ok(res.ok, `${path}: ${await res.clone().text()}`);
      return res.json();
    };
    await get('api/story');
    await post('api/ops', { prototype: 'inicio', did: 'flujo de compra', ops: [
      { op: 'add_page', page: { id: 'pago', title: 'Pago', children: [
        { id: 'pago-titulo', type: 'text', as: 'h1', text: 'Pago' },
        { id: 'pagar', type: 'button', class: 'btn-primary', text: 'Pagar' },
      ] } },
      { op: 'insert', parent: 'inicio', node: { id: 'comprar', type: 'button', text: 'Comprar', class: 'btn-primary', on: { click: { go: 'pago' } } } },
    ] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const composer = page.locator('.composer textarea');
    await composer.waitFor();
    assert.equal(await composer.isEnabled(), true, 'composer must stay usable without Pi');
    await composer.fill('abre pago');
    await composer.press('Enter');
    await page.waitForURL('**/#/p/inicio/pago');
    await page.getByText('Abierta «Pago».', { exact: true }).first().waitFor();
    assert.equal(await page.locator('.status.working').count(), 0, 'a local command must not leave the agent working');
    const canvas = page.frameLocator('.canvas iframe');
    await canvas.locator('#pagar').waitFor({ state: 'visible' });
    assert.equal(await canvas.locator('#pagar').evaluate(el => getComputedStyle(el).borderRadius), '12px');
    const html = await readFile(join(project.protoDir, 'dist', 'inicio.html'), 'utf8');
    const tokens = await readTokens(project.protoDir);
    tokens.radius = { ...tokens.radius, card: '28px' };
    await writeFile(join(project.protoDir, 'guide', 'tokens.yaml'), YAML.stringify(tokens));
    await page.waitForFunction(() => {
      const frame = document.querySelector('.canvas iframe') as HTMLIFrameElement;
      const node = frame?.contentDocument?.querySelector('#pagar');
      return node && frame.contentWindow!.getComputedStyle(node).borderRadius === '28px';
    });
    assert.equal(await readFile(join(project.protoDir, 'dist', 'inicio.html'), 'utf8'), html);

    // Explicit selection sends exact YAML without calling another model.
    const stream = await fetch(base + '__session?id=browser-test', { signal: controller.signal });
    await post('__session/report', { id: 'browser-test', agent: { state: 'idle' } });
    const reader = stream.body!.getReader();
    const asked = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error('session ended before ask');
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        const block = blocks.find(b => b.startsWith('event: ask\n'));
        if (block) return JSON.parse(block.split('\ndata: ')[1]!);
      }
    })();
    await page.getByRole('button', { name: 'Seleccionar', exact: true }).click();
    await canvas.locator('#pago-titulo').click();
    await composer.fill('el título más chico');
    await composer.press('Enter');
    const message = await asked;
    assert.equal(message.target.node, 'pago-titulo');
    assert.match(message.context.yaml, /text: Pago/);
    await page.waitForFunction(() => !document.querySelector('.composer textarea')?.hasAttribute('disabled'));
    assert.equal(await page.locator('.status.working').count(), 0, 'an HTTP ack must not resurrect a completed agent');
    await post('__session/report', { id: 'browser-test', preview: 'Estoy ajustando el título.' });
    await page.getByText('Estoy ajustando el título.', { exact: true }).waitFor();
    await post('__session/report', { id: 'browser-test', agent: { state: 'idle' } });
    await composer.fill('deshaz');
    await composer.press('Enter');
    await page.getByText('Deshecho el último cambio.', { exact: true }).first().waitFor();
    const p = await (await get('api/prototype?id=inicio')).json() as any;
    assert.equal(p.version, 3);
    assert.deepEqual(p.pages.map((pg: any) => pg.id), ['inicio']);
    await page.getByRole('link', { name: 'Patrones existentes', exact: true }).click();
    await page.frameLocator('.canvas iframe').getByRole('heading', { name: 'btn-primary', exact: true }).waitFor();
    const example = page.frameLocator('.canvas iframe').getByRole('button', { name: 'Continuar', exact: true });
    assert.equal(await example.evaluate(el => getComputedStyle(el).borderRadius), '28px');
    await page.getByRole('button', { name: 'Ocultar', exact: true }).click();
    await page.screenshot({ path: '/private/tmp/pi-proto-componentes.png', fullPage: true });
    await page.getByRole('link', { name: 'Entrega', exact: true }).click();
    await page.frameLocator('.canvas iframe').getByRole('heading', { name: 'Navegación para desarrollar', exact: true }).waitFor();
    await page.screenshot({ path: '/private/tmp/pi-proto-entrega.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Páginas', exact: false }).click();
    await page.locator('.sidebar a[href="#/p/inicio"]').click();
    await page.locator('.sidebar').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Ancho', exact: true }).click();
    await canvas.locator('#titulo').waitFor({ state: 'visible' });
    const fit = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, canvasHeight: document.querySelector('.canvas')!.clientHeight, mainWidth: document.querySelector('.main')!.clientWidth }));
    assert.ok(fit.scrollWidth <= fit.width, JSON.stringify(fit));
    assert.equal(fit.mainWidth, 390);
    assert.ok(fit.canvasHeight > 250, JSON.stringify(fit));
    await page.screenshot({ path: '/private/tmp/pi-proto-mobile-fast.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    controller.abort();
    await browser.close();
    await server.close();
    if (previousHome === undefined) delete process.env['PI_PROTO_HOME']; else process.env['PI_PROTO_HOME'] = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});
