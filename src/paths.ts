import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

/**
 * Resolve a path to its real location. Symlinks, `..`, and missing leaf files
 * are handled: if the leaf is missing we resolve the nearest existing ancestor
 * and reattach the missing suffix, so two callers comparing prefixes never see
 * `/var/folders/...` vs `/private/var/folders/...` for the same target.
 */
export const resolveReal = async (input: string): Promise<string> => {
  const target = resolve(input);
  try {
    return await realpath(target);
  } catch {
    return resolveMissing(target);
  }
};

const resolveMissing = (target: string): string => {
  if (existsSync(target)) return realpathSync(target);
  const parent = dirname(target);
  if (parent === target) return target;
  const realParent = resolveMissing(parent);
  return resolve(realParent, basename(target));
};

const normalize = (path: string): string => path.replaceAll('\\', '/').replace(/\/+$/u, '');

/** True when `child` is the same as or sits inside `parent` after both are real-pathed. */
export const isWithin = (parent: string, child: string): boolean => {
  const a = normalize(parent);
  const b = normalize(child);
  return b === a || b.startsWith(`${a}/`);
};

/** Strip the parent prefix and turn it into a forward-slash relative path. */
export const relativeTo = (parent: string, child: string): string | undefined => {
  const a = normalize(parent);
  const b = normalize(child);
  if (b === a) return '';
  const prefix = `${a}/`;
  return b.startsWith(prefix) ? b.slice(prefix.length) : undefined;
};

/** Cross-platform path join that keeps forward slashes for display. */
export const joinPath = (...parts: readonly string[]): string =>
  parts.filter(Boolean).join('/').replace(/\/+/gu, '/');

/** Single-segment separator used by the workspace. */
export const PROTO_COMPONENT = 'proto';
export const PROTO_CONFIG = 'proto.json';
export const PROTO_LOCK = 'proto.lock';
export const PROTO_GUIDE_DIR = 'guide';
export const PROTO_OUT_DIR = '.out';
export const PROTO_SHOTS_DIR = 'screenshots';
export const PROTO_FRONTEND_DIR = 'frontend';

export { sep };
