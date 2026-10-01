/**
 * Proto mode is on when any of these is true:
 * - The session ran `/proto on` (or `proto_init`/`proto_review` did).
 * - `PI_PROTO_MODE=1` is exported.
 * - `proto.json` exists for the project.
 *
 * The role is set explicitly: the agent can run `/proto role <name>` or set
 * `PI_PROTO_ROLE`. pi-proto does not import pi-team; if the user wants team
 * awareness they install both packages and the role still works.
 */
export type ProtoMode = Readonly<{
  enabled: boolean;
  role: string;
  source: 'flag' | 'env' | 'config' | 'unset';
}>;

const VALID_ROLE = /^[a-z][a-z0-9-]{0,31}$/u;

export const normalizeRole = (raw: string | undefined): string => {
  if (!raw) return 'ux';
  const trimmed = raw.trim().toLowerCase();
  return VALID_ROLE.test(trimmed) ? trimmed : 'ux';
};

export const readMode = (configExists: boolean, configuredRole?: string): ProtoMode => {
  const envMode = process.env.PI_PROTO_MODE === '1' || process.env.PI_PROTO_MODE === 'true';
  const envRole = normalizeRole(process.env.PI_PROTO_ROLE);
  if (envMode) return { enabled: true, role: envRole, source: 'env' };
  if (configExists) return { enabled: true, role: configuredRole ? normalizeRole(configuredRole) : envRole, source: 'config' };
  return { enabled: false, role: envRole, source: 'unset' };
};

/**
 * Decide whether `role` is allowed to write `target` under the current config.
 * The guard calls this for every `edit` / `write` / bash redirection while
 * proto mode is on.
 */
export const isWriteAllowed = (input: Readonly<{
  role: string;
  protoRoles: readonly string[];
  portRoles: readonly string[];
  target: 'proto' | 'allow' | 'ui-approved' | 'ui-other';
}>): boolean => {
  if (input.target === 'proto' || input.target === 'allow') return true;
  if (input.target === 'ui-approved') return [...input.portRoles, ...input.protoRoles].includes(input.role);
  return false;
};
