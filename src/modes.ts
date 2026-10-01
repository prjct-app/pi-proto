import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { setMode } from '@prjct.app/pi-tui-kit';

/** The context shape the kit's mode line needs; tests and RPC hosts may not have it. */
type Ctx = Pick<ExtensionContext, 'hasUI' | 'ui'>;

const canPublish = (ctx: Ctx): boolean => {
  const ui = ctx.ui as Partial<ExtensionContext['ui']>;
  return ctx.hasUI && typeof ui.theme === 'object' && ui.theme !== null
    && typeof ui.setStatus === 'function'
    && typeof ui.setWidget === 'function';
};

/**
 * Clear legacy Prototype mode indicators. No idle/live badge is published.
 */
export const showStatus = (ctx: Ctx | undefined, label: string | undefined): void => {
  if (!ctx || !canPublish(ctx)) return;
  setMode(ctx as ExtensionContext, 'proto', label);
};
