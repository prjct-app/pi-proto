import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ProtoConfig } from '../config.ts';
import { StatusFile } from '../status.ts';
import { resolveProtoProject, type ResolvedProject } from '../project.ts';
import { createPrototype, listPrototypes } from './store.ts';
import { STARTER_TOKENS, TOKENS_FILE } from './tokens.ts';

/**
 * Create a project's design workspace in ~/.prjct/<project>/proto: proto.json
 * (who the project is), the design guide (tokens and a vision page), and a
 * first prototype. Idempotent: an existing workspace is left as it is.
 */

export type InitArtifact = 'workspace' | 'tokens' | 'guide' | 'prototype';

export const initWorkspace = async (location: string, by = 'person', options: { artifact?: InitArtifact; starter?: boolean } = {}): Promise<{ project: ResolvedProject; created: boolean }> => {
  const project = await resolveProtoProject(location);
  const protoDir = project.protoDir;
  await mkdir(join(protoDir, 'guide'), { recursive: true });
  await mkdir(join(protoDir, 'prototypes'), { recursive: true });
  const status = new StatusFile(protoDir);
  const existing = await status.read();
  if (!existing) {
    const config: ProtoConfig = {
      schemaVersion: 1,
      project: { name: basename(project.location) || 'proyecto', projectId: project.projectId, location: project.location },
      stack: 'plain',
      styling: 'tw4-postcss',
      darkMode: 'class',
      viewports: [
        { label: 'mobile', width: 390, height: 844 },
        { label: 'tablet', width: 820, height: 1180 },
        { label: 'desktop', width: 1280, height: 800 },
      ],
      ui: { paths: [], gate: 'off' },
      team: { protoRoles: ['ux', 'qa'], portRoles: ['fe'] },
      allowWrite: [],
      sitemap: [],
      items: [],
    };
    await status.write(config);
  }
  // A workspace is not a request for a prototype or a generic visual identity.
  // Starter values are opt-in fixtures/demos; real tokens come from references.
  await writeFile(join(protoDir, 'guide', TOKENS_FILE), options.starter ? STARTER_TOKENS : '{}\n', { flag: 'wx' }).catch(() => undefined);
  if (options.artifact === 'prototype' && !(await listPrototypes(protoDir)).length) await createPrototype(protoDir, { title: 'Inicio', by });
  return { project, created: !existing };
};
