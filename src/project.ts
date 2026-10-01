import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { componentPath, memoryHomeFor, resolveProject, PROTO_COMPONENT_NAME } from './identity.ts';

/** Resolved project: real location, signed-or-derived id, proto folder. */
export type ResolvedProject = Readonly<{
  /** Canonical cwd after `realpath`. */
  location: string;
  /** `p_` id, signed or derived. */
  projectId: string;
  /** `co_` id for the checkout. */
  checkoutId: string;
  /** `~/.prjct/<projectId>/proto/` (or `$PRJCT_HOME/<projectId>/proto/`). */
  protoDir: string;
}>;

/**
 * Resolve the project for a session. The home is read from `PI_PROTO_HOME`,
 * `PI_MEMORY_HOME` or `PRJCT_HOME` when set, else `~/.prjct`.
 */
export const resolveProtoProject = async (cwd: string): Promise<ResolvedProject> => {
  const home = memoryHomeFor();
  const canonical = await realpath(resolve(cwd));
  const { projectId, checkoutId } = await resolveProject(canonical, home);
  return {
    location: canonical,
    projectId,
    checkoutId,
    protoDir: componentPath(home, 'project', projectId, PROTO_COMPONENT_NAME),
  };
};
