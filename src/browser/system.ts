import { spawn } from 'node:child_process';

/**
 * Open a URL in the person's default browser, the one they already use, not a
 * browser Pi controls. False when there is no opener; PI_PROTO_NO_BROWSER=1
 * skips it (tests, remote sessions).
 */
export const openDefaultBrowser = (url: string): Promise<boolean> => new Promise(resolve => {
  if (process.env['PI_PROTO_NO_BROWSER'] === '1') { resolve(false); return; }
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  } catch {
    resolve(false);
  }
});
