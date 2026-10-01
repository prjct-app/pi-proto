import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryHomeFor } from '../identity.ts';

/**
 * The proto daemon: one long-lived process per prjct home that serves every
 * project's storybook, watches and builds the prototypes, and carries the live
 * events between browsers and Pi sessions. It never calls a model: Pi is the
 * engine. Same shape as the pi-memory daemon (pid, alive, log under
 * ~/.prjct/shared/<name>/daemon), as a sibling so one never takes the other down.
 */

export type Alive = Readonly<{ pid: number; token: string; port: number; url: string; startedAt: number }>;

export const DEFAULT_PORT = 51700;
/** A healthy older process must not keep serving old code after installation. */
export const DAEMON_REVISION = 4;

export const daemonHome = (): string => memoryHomeFor();
export const stateDir = (home: string): string => join(home, 'shared', 'proto', 'daemon');
const alivePath = (home: string): string => join(stateDir(home), 'proto.alive');
export const logPath = (home: string): string => join(stateDir(home), 'proto.log');

export const isRunning = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export const readAlive = async (home: string): Promise<Alive | undefined> => {
  const raw = await readFile(alivePath(home), 'utf8').catch(() => undefined);
  if (!raw) return undefined;
  try {
    const alive = JSON.parse(raw) as Alive;
    return Number.isInteger(alive.pid) && typeof alive.url === 'string' ? alive : undefined;
  } catch {
    return undefined;
  }
};

export const announceAlive = async (home: string, alive: Alive): Promise<void> => {
  mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  await writeFile(alivePath(home), JSON.stringify(alive), { mode: 0o600 });
};

export const clearAlive = async (home: string, token: string): Promise<void> => {
  const alive = await readAlive(home);
  if (alive?.token === token) await rm(alivePath(home), { force: true });
};

const health = async (url: string): Promise<{ pid?: number; revision?: number } | undefined> => {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() as { pid?: number; revision?: number } : undefined;
  } catch {
    return undefined;
  }
};

export const daemonStatus = async (home = daemonHome()): Promise<{ running: boolean; current?: boolean; alive?: Alive }> => {
  const alive = await readAlive(home);
  if (!alive || !isRunning(alive.pid)) return { running: false };
  const found = await health(alive.url);
  return { running: found?.pid === alive.pid, current: found?.revision === DAEMON_REVISION, alive };
};

/** The CLI entry, next to this module: the .ts source in a checkout, the .js mirror in the Pi build. */
const cliPath = (): string => {
  const own = fileURLToPath(import.meta.url);
  const candidates = own.endsWith('.ts') ? ['./cli.ts'] : ['./cli.js', './src/daemon/cli.js'];
  const paths = candidates.map(relative => fileURLToPath(new URL(relative, import.meta.url)));
  return paths.find(path => existsSync(path)) ?? paths[0]!;
};

/** Start the daemon unless one already answers; resolves with where it listens. */
export const ensureDaemon = async (home = daemonHome(), argv: readonly string[] = process.execArgv): Promise<Alive> => {
  const status = await daemonStatus(home);
  if (status.running && status.current && status.alive) return status.alive;
  if (status.running && status.alive) await stopDaemon(home);
  mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const log = await open(logPath(home), 'a', 0o600);
  const child = spawn(process.execPath, [...argv, cliPath(), 'run'], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, PI_PROTO_HOME: home, PI_PROTO_DAEMON_TOKEN: token },
  });
  child.unref();
  await log.close();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const alive = await readAlive(home);
    if (alive?.token === token && (await health(alive.url))?.revision === DAEMON_REVISION) return alive;
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the proto daemon did not start; see ${logPath(home)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

export const stopDaemon = async (home = daemonHome()): Promise<{ stopped: boolean; pid?: number }> => {
  const alive = await readAlive(home);
  if (!alive || !isRunning(alive.pid)) {
    await rm(alivePath(home), { force: true });
    return { stopped: true };
  }
  process.kill(alive.pid, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (isRunning(alive.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (isRunning(alive.pid)) process.kill(alive.pid, 'SIGKILL');
  await rm(alivePath(home), { force: true });
  return { stopped: true, pid: alive.pid };
};
