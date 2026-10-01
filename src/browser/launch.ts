import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Viewport } from '../config.ts';

export type LaunchOptions = Readonly<{
  url: string;
  channel: string;
  viewports: readonly Viewport[];
  outDir: string;
  /** When true, no real browser is opened; this is only used to render screenshots. */
  headless?: boolean;
}>;

export type ScreenshotResult = Readonly<{
  viewport: string;
  file: string;
  width: number;
  height: number;
}>;

/** Resolve the playwright CLI from the same node_modules that hosts the
 *  bundled `playwright-core`. `playwright/cli.js` is not in the package's
 *  `exports` map, so resolve the directory from `package.json` and join. */
const resolvePlaywrightCli = (): string => {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('playwright/package.json');
  return join(pkgPath.replace(/package\.json$/, ''), 'cli.js');
};

/** Run `playwright install chromium` and stream the output. Used when the
 *  first screenshot in a project needs a browser that is not yet on disk. */
const installChromium = (): Promise<void> => new Promise((ok, fail) => {
  try {
    const proc = spawn(process.execPath, [resolvePlaywrightCli(), 'install', 'chromium'], {
      // Never inherit: its progress bars would draw over Pi's terminal UI.
      stdio: ['ignore', 'ignore', 'ignore'],
      env: process.env,
    });
    proc.once('error', fail);
    proc.once('exit', (code) => {
      if (code === 0) ok();
      else fail(new Error(`playwright install chromium exited with code ${code}`));
    });
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }
});

const MISSING_BROWSER = /Executable doesn't exist|browser was not found|chromium.*not installed/i;

const launchChromium = async (playwright: typeof import('playwright-core'), options: { headless: boolean; args?: string[] }): Promise<import('playwright-core').Browser> => {
  try {
    return await playwright.chromium.launch({ headless: options.headless, args: options.args });
  } catch (error) {
    if (!MISSING_BROWSER.test(String(error))) throw error;
    // First-time use: install the browser, then try again.
    await installChromium();
    return playwright.chromium.launch({ headless: options.headless, args: options.args });
  }
};

/** Take screenshots of the running prototype for every configured viewport.
 *  Uses Playwright's bundled Chromium; if it is not installed yet, runs
 *  `playwright install chromium` once and retries. No system Chrome needed. */
export const launchAndShoot = async (options: LaunchOptions): Promise<readonly ScreenshotResult[]> => {
  const playwright = await import('playwright-core');
  const browser = await launchChromium(playwright, { headless: options.headless !== false });
  const out: ScreenshotResult[] = [];
  for (const vp of options.viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await page.goto(options.url, { waitUntil: 'networkidle' });
    const safe = vp.label.replace(/[^a-z0-9-]+/gi, '_').toLowerCase();
    const file = join(options.outDir, `${safe}.png`);
    await mkdir(options.outDir, { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
    await ctx.close();
    out.push({ viewport: vp.label, file, width: vp.width, height: vp.height });
  }
  await browser.close();
  return out;
};

/** Open a comment window in the user's default browser. Returns the browser
 *  handle so the caller can keep the process alive (window stays open).
 *  Uses Playwright's bundled Chromium; auto-installs on first use. */
export const openInBrowser = async (url: string): Promise<{ alive: () => boolean; close: () => Promise<void> } | undefined> => {
  const playwright = await import('playwright-core');
  const browser = await launchChromium(playwright, { headless: false, args: ['--new-window'] }).catch(() => undefined);
  if (!browser) return undefined;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return {
    alive: () => browser.isConnected?.() ?? false,
    close: () => browser.close().then(() => undefined),
  };
};

