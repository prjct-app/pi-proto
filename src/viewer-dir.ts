import { join } from 'node:path';
import { memoryHomeFor } from './identity.ts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The storybook app lives outside Pi, in the prjct home (~/.prjct/proto-viewer,
 * built into dist/). pi-proto and its daemon only serve that folder to the
 * browser; none of it loads into Pi. PI_PROTO_VIEWER points elsewhere (tests).
 */
export const viewerDir = (): string => {
  if (process.env['PI_PROTO_VIEWER']) return process.env['PI_PROTO_VIEWER'];
  const bundled = fileURLToPath(new URL('../viewer/dist', import.meta.url));
  return existsSync(join(bundled, 'index.html')) ? bundled : join(memoryHomeFor(), 'proto-viewer', 'dist');
};
