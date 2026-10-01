import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Name of the pi-proto component folder inside each project scope. */
export const PROTO_COMPONENT_NAME = 'proto';

/**
 * Project identity resolution, inlined from pi-memory so pi-proto can stay a
 * single-package install. The behaviour is identical: the first ancestor whose
 * `.prjct/prjct.config.json` id is signed in `~/.prjct/identity/index.json`
 * wins, otherwise the project id is `p_<sha256(realpath).slice(0,12)>`.
 */

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export const PROJECT_ID_PREFIX = 'p_';
export const CHECKOUT_ID_PREFIX = 'co_';

export const projectIdFrom = (canonicalLocation: string): string => `p_${sha256(canonicalLocation).slice(0, 12)}`;
export const checkoutIdFrom = (canonicalLocation: string): string => `co_${sha256(canonicalLocation).slice(0, 12)}`;
export const assertProjectId = (projectId: string): string => {
  if (!/^p_[A-Za-z0-9_-]+$/u.test(projectId)) throw new Error('Memory opens only a project-owned database.');
  return projectId;
};

export const memoryHomeFor = (override?: string): string => resolve(override
  ?? process.env.PI_PROTO_HOME
  ?? process.env.PI_MEMORY_HOME
  ?? process.env.PRJCT_HOME
  ?? join(homedir(), '.prjct'));

export const componentPath = (home: string, kind: 'project' | 'team' | 'shared', id: string, component = 'memory'): string => {
  if (!/^[a-z][a-z0-9-]*$/u.test(component)) throw new Error('Invalid component name.');
  if (kind === 'project') {
    assertProjectId(id);
    return join(home, id, component);
  }
  if (kind === 'shared') return join(home, 'shared', component);
  return join(home, 'teams', id, component);
};

type IdentityBinding = Readonly<{ location: string; projectId: string }>;

const locatorProjectId = async (location: string): Promise<string | undefined> => {
  const raw = await readFile(join(location, '.prjct', 'prjct.config.json'), 'utf8').catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const projectId = (parsed as { projectId?: unknown }).projectId;
    return typeof projectId === 'string' && /^p_[A-Za-z0-9_-]+$/u.test(projectId) ? projectId : undefined;
  } catch {
    return undefined;
  }
};

const verifiedBindings = async (home: string): Promise<readonly IdentityBinding[]> => {
  const raw = await readFile(join(home, 'identity', 'index.json'), 'utf8').catch(() => undefined);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const envelope = parsed as { schemaVersion?: unknown; revision?: unknown; contentHash?: unknown; payload?: unknown };
    if (envelope.schemaVersion !== 1 || !Number.isSafeInteger(envelope.revision) || Number(envelope.revision) < 1
      || typeof envelope.contentHash !== 'string' || sha256(JSON.stringify(envelope.payload)) !== envelope.contentHash
      || !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return [];
    const bindings = (envelope.payload as { bindings?: unknown }).bindings;
    if (!Array.isArray(bindings)) return [];
    return bindings.flatMap(binding => {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return [];
      const row = binding as { location?: unknown; projectId?: unknown };
      return typeof row.location === 'string' && typeof row.projectId === 'string' && /^p_[A-Za-z0-9_-]+$/u.test(row.projectId)
        ? [{ location: resolve(row.location), projectId: row.projectId }]
        : [];
    });
  } catch {
    return [];
  }
};

/**
 * Resolve the project for a session. Walks up from cwd through pi-memory's
 * binding index so that two checkouts of the same project land on the same
 * proto folder.
 */
export const resolveProject = async (cwd: string, home = memoryHomeFor()): Promise<{ location: string; projectId: string; checkoutId: string }> => {
  const location = await realpath(resolve(cwd));
  const located = await locatorProjectId(location);
  const trusted = located && (await verifiedBindings(home)).some(binding => binding.location === location && binding.projectId === located);
  return { location, projectId: trusted ? located : projectIdFrom(location), checkoutId: checkoutIdFrom(location) };
};

// Compatibility with the path helpers from `paths.ts`.
// (Nothing to re-export: identity.ts only contributes its own surface.)
