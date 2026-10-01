import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Value } from 'typebox/value';
import { PROTO_CONFIG, PROTO_OUT_DIR, joinPath } from './paths.ts';
import { ProtoConfigSchema, type ProtoConfig, type ProtoItem } from './config.ts';

export type ProtoConfigData = ProtoConfig;

/**
 * Single source of truth for a project's prototype. Writes are atomic: write
 * to a temp file, fsync, rename. Reads validate the schema and fall back to
 * the parsed value when the file does not yet exist (proto_init has not run).
 */
export class StatusFile {
  private readonly path: string;
  private cache: { mtimeMs: number; data: ProtoConfig } | undefined;

  constructor(protoDir: string) {
    this.path = join(protoDir, PROTO_CONFIG);
  }

  get filePath(): string {
    return this.path;
  }

  async read(): Promise<ProtoConfig | undefined> {
    if (!existsSync(this.path)) return undefined;
    const stat = await import('node:fs/promises').then(fs => fs.stat(this.path));
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs) return this.cache.data;
    const raw = await readFile(this.path, 'utf8');
    const data = tryParseProtoJson(raw);
    if (!data) return undefined;
    this.cache = { mtimeMs: stat.mtimeMs, data };
    return data;
  }

  async write(next: ProtoConfig): Promise<void> {
    const valid = Value.Parse(ProtoConfigSchema, next) as ProtoConfig;
    const serialised = `${JSON.stringify(valid, null, 2)}\n`;
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, serialised, { flag: 'wx' });
    await rename(temp, this.path);
    this.cache = { mtimeMs: Date.now(), data: valid };
  }

  async update(updater: (current: ProtoConfig) => ProtoConfig): Promise<ProtoConfig> {
    const current = (await this.read()) ?? (await this.bootstrapEmpty());
    const next = updater(current);
    await this.write(next);
    return next;
  }

  /** Bootstrap an empty config when no proto.json exists yet. */
  private async bootstrapEmpty(): Promise<ProtoConfig> {
    throw new Error(`proto.json does not exist at ${this.path}; run proto_init first.`);
  }

  /** Folder that holds generated artifacts (CSS, HTML, screenshots). */
  outDir(): string {
    return join(dirname(this.path), PROTO_OUT_DIR);
  }

  /** Path inside the workspace; used for journaled artifact references. */
  workspacePath(...parts: readonly string[]): string {
    return joinPath(PROTO_OUT_DIR, ...parts);
  }
}

/** Recompute the content hash for an item from its on-disk sources. */
export const hashSources = (sources: readonly string[]): string => {
  const hash = createHash('sha256');
  for (const source of sources) hash.update(source);
  return hash.digest('hex');
};

/**
 * Mark items whose content hash no longer matches as `changed`. The guard
 * relies on this: any edit after approval flips the item and the next write
 * is blocked until the user approves again.
 */
export const reconcileContentHashes = (items: readonly ProtoItem[], hashes: Readonly<Record<string, string>>): readonly ProtoItem[] =>
  items.map(item => {
    const next = hashes[item.id];
    if (!next) return item;
    if (item.contentHash === next) return item;
    return { ...item, status: item.status === 'approved' ? 'changed' : item.status, contentHash: next };
  });

const rename = async (from: string, to: string): Promise<void> => {
  const { rename } = await import('node:fs/promises');
  await rename(from, to);
};

const tryParseProtoJson = (raw: string): ProtoConfig | undefined => {
  try { return Value.Parse(ProtoConfigSchema, JSON.parse(raw)) as ProtoConfig; } catch { return undefined; }
};
