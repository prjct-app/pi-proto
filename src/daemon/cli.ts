import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { viewerDir } from '../viewer-dir.ts';
import { announceAlive, clearAlive, daemonHome, daemonStatus, DEFAULT_PORT, ensureDaemon, stopDaemon } from './lifecycle.ts';
import { startServer, type DaemonServer } from './server.ts';

/** `proto-daemon start|stop|status|run`: run is what start spawns, detached. */
const run = async (): Promise<void> => {
  const home = daemonHome();
  const token = process.env['PI_PROTO_DAEMON_TOKEN'];
  if (!token) throw new Error('PI_PROTO_DAEMON_TOKEN is required for run; use start.');
  const viewer = viewerDir();
  if (!existsSync(join(viewer, 'index.html'))) console.error(`warning: the storybook app is not built at ${viewer}`);
  const base = Number(process.env['PI_PROTO_DAEMON_PORT'] ?? DEFAULT_PORT);
  // The usual port, or the next free one; the alive file says which.
  const listen = async (port: number): Promise<DaemonServer> => {
    if (port >= base + 20) throw new Error(`no free port from ${base}`);
    try { return await startServer({ home, port, viewer }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; return listen(port + 1); }
  };
  const server = await listen(base);
  await announceAlive(home, { pid: process.pid, token, port: server.port, url: server.url, startedAt: Date.now() });
  console.error(JSON.stringify({ event: 'listening', url: server.url, at: new Date().toISOString() }));
  const shutdown = async (): Promise<void> => {
    await server!.close().catch(() => undefined);
    await clearAlive(home, token);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
};

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? 'status';
  if (command === 'run') return run();
  const result = command === 'start' ? await ensureDaemon()
    : command === 'stop' ? await stopDaemon()
    : await daemonStatus();
  console.log(JSON.stringify(result, null, 2));
};

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
