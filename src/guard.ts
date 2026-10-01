import { isAbsolute, resolve } from 'node:path';
import { classifyBash } from './bash.ts';
import { isWithin, resolveReal } from './paths.ts';
import { readMode, normalizeRole } from './mode.ts';
import type { ProtoConfig } from './config.ts';

/**
 * The guard sits in front of every `tool_call`. When proto mode is on, it
 * blocks writes that are not on the allow-list: the proto folder, the
 * `allowWrite` paths, or a target file of an approved item.
 */
export type GuardInput = Readonly<{
  toolName: string;
  input: unknown;
  /** The realpath of the project location recorded in proto.json. */
  projectRoot: string;
  /** The realpath of `~/.prjct/<p_id>/proto/`; writes inside it are always allowed. */
  protoDir: string;
  /** Loaded proto.json; undefined when proto_init has not run. */
  config: ProtoConfig | undefined;
}>;

export type GuardDecision = Readonly<{
  block: boolean;
  reason?: string;
}>;

/** Tools that never write, regardless of mode. */
const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'find',
  'proto_init', 'proto_open', 'proto_build', 'proto_shot', 'proto_review', 'proto_reply',
]);

const isFileTool = (name: string): boolean =>
  /write|edit|patch|create|update/u.test(name);

const isBashTool = (name: string): boolean => name === 'bash' || name === 'shell';

const stringAt = (obj: unknown, key: string): string | undefined => {
  if (!obj || typeof obj !== 'object') return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
};

const collectStringPaths = (input: unknown): readonly string[] => {
  const collect = (value: unknown, out: string[]): void => {
    if (typeof value === 'string') {
      if (value.includes('/') || value.includes('\\')) out.push(value);
      return;
    }
    if (Array.isArray(value)) { for (const v of value) collect(v, out); return; }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) collect(v, out);
    }
  };
  const out: string[] = [];
  collect(input, out);
  return [...new Set(out)];
};

const realpathSafe = async (path: string): Promise<string | undefined> => {
  try { return await resolveReal(path); } catch { return undefined; }
};

const classifyTarget = async (
  realPath: string,
  config: ProtoConfig,
  projectRoot: string,
  protoDir: string,
): Promise<'proto' | 'allow' | 'project' | 'ui-approved' | 'ui-other'> => {
  if (isWithin(protoDir, realPath)) return 'proto';
  const allowReal = await Promise.all(config.allowWrite.map(async allowed => (await realpathSafe(allowed)) ?? allowed));
  if (allowReal.some(allowed => isWithin(allowed, realPath))) return 'allow';

  if (!isWithin(projectRoot, realPath)) return 'allow';

  const uiReal = await Promise.all(config.ui.paths.map(async uiPath => (await realpathSafe(uiPath)) ?? uiPath));
  const inUi = uiReal.length === 0 || uiReal.some(uiPath => isWithin(uiPath, realPath));
  if (!inUi) return 'project';

  const approvedTargets = config.items
    .filter(item => item.status === 'approved')
    .flatMap(item => item.targets);
  for (const target of approvedTargets) {
    const targetReal = (await realpathSafe(target)) ?? target;
    if (targetReal === realPath || isWithin(targetReal, realPath)) return 'ui-approved';
  }
  return 'ui-other';
};

const decideForPaths = async (
  paths: readonly string[],
  input: GuardInput,
): Promise<GuardDecision> => {
  const config = input.config;
  if (!config) {
    return {
      block: true,
      reason: 'proto mode is on but proto.json is missing. Run proto_init first to create the workspace.',
    };
  }
  const blocked: { path: string; item: { id: string; status: string } } | undefined = await (async () => {
    for (const path of paths) {
      if (path.includes('*')) continue;
      const abs = isAbsolute(path) ? path : resolve(input.projectRoot, path);
      const real = (await realpathSafe(abs)) ?? abs;
      const category = await classifyTarget(real, config, input.projectRoot, input.protoDir);
      if (category === 'ui-other') {
        const item = await findOwningItem(config, real);
        return { path: real, item: item ? { id: item.id, status: item.status } : { id: '<unowned>', status: 'draft' } };
      }
    }
    return undefined;
  })();

  if (blocked) {
    return {
      block: true,
      reason: `proto mode blocks write to ${blocked.path}: it is a UI file owned by item "${blocked.item.id}" (status: ${blocked.item.status}). ` +
        `Run /proto approve ${blocked.item.id} to allow edits, or /proto off to disable the guard.`,
    };
  }

  return { block: false };
};

const findOwningItem = async (config: ProtoConfig, realPath: string): Promise<{ id: string; status: string } | undefined> => {
  for (const item of config.items) {
    for (const target of item.targets) {
      const targetReal = (await realpathSafe(target)) ?? target;
      if (targetReal === realPath || isWithin(targetReal, realPath)) {
        return { id: item.id, status: item.status };
      }
    }
  }
  return undefined;
};

export const guard = async (input: GuardInput): Promise<GuardDecision | undefined> => {
  const configExists = input.config !== undefined;
  const role = normalizeRole(process.env.PI_PROTO_ROLE);
  const mode = readMode(configExists, input.config && input.config.team.protoRoles.includes(role) ? role : undefined);
  if (!mode.enabled) return undefined;
  if (READ_ONLY_TOOLS.has(input.toolName)) return undefined;
  if (!isFileTool(input.toolName) && !isBashTool(input.toolName)) return undefined;
  // Canonicalize the project root and proto dir so a `project.location` that
  // pre-dates symlink canonicalization still matches the realpathed candidate.
  const projectRoot = (await realpathSafe(input.projectRoot)) ?? input.projectRoot;
  const protoDir = (await realpathSafe(input.protoDir)) ?? input.protoDir;

  if (isBashTool(input.toolName)) {
    const command = typeof input.input === 'string'
      ? input.input
      : stringAt(input.input, 'command') ?? stringAt(input.input, 'cmd') ?? '';
    if (!command) return undefined;
    const finding = classifyBash(command);
    if (finding.intent === 'none') return undefined;
    const result = await decideForPaths(finding.paths, { ...input, projectRoot, protoDir });
    return result;
  }

  const paths = collectStringPaths(input.input);
  if (!paths.length) return undefined;
  return decideForPaths(paths, { ...input, projectRoot, protoDir });
};
