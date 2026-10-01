import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { brand, completer } from '@prjct.app/pi-tui-kit';
import type { ProtoController } from './host.ts';
import { openDefaultBrowser } from './browser/system.ts';
import { daemonStatus, stopDaemon } from './daemon/lifecycle.ts';

/** `/proto`: open the storybook; `init` creates it; `status`; `daemon stop`. */
export const registerCommand = (pi: ExtensionAPI, controller: ProtoController): void => {
  pi.registerCommand('proto', {
    description: brand('Prototype: open | init | status | daemon stop'),
    getArgumentCompletions: completer([
      { value: 'open', description: 'open Prototype in the browser' },
      { value: 'init', description: 'create the design workspace and open it' },
      { value: 'status', description: 'Prototype address and connection' },
      { value: 'daemon', description: 'the Prototype daemon', options: [{ value: 'stop', description: 'stop it; the next Pi session starts it again' }] },
    ]),
    handler: async (args, ctx) => {
      const [word = 'open', sub = ''] = args.trim().split(/\s+/);
      try {
        if (word === 'daemon' && sub === 'stop') { const r = await stopDaemon(); ctx.ui.notify(r.stopped ? 'Prototype daemon stopped.' : 'The daemon did not stop.', 'info'); return; }
        if (word === 'status') {
          const status = await daemonStatus();
          const p = await controller.project();
          ctx.ui.notify(!p ? 'This folder is not a project.'
            : status.running && status.alive ? `Prototype: ${status.alive.url}/${p.projectId}/`
            : 'Prototype is not running; /proto open starts it.', 'info');
          return;
        }
        const c = await controller.connect({ init: word === 'init' });
        const opened = await openDefaultBrowser(c.base);
        ctx.ui.notify(`Prototype: ${c.base}${opened ? '' : ' (open it in your browser)'}`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
};
