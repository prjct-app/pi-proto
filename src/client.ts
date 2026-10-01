import { daemonHome, ensureDaemon, type Alive } from './daemon/lifecycle.ts';

/**
 * pi-proto's side of the daemon: plain HTTP calls and one event stream per
 * session. The daemon holds the storybook; this Pi session is the engine that
 * answers what the person asks in it.
 */

type Json = Record<string, unknown>;

export const daemon = (): Promise<Alive> => ensureDaemon(daemonHome());

export const call = async <T = Json>(base: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${base}${path}`, body === undefined
    ? { signal: AbortSignal.timeout(30_000) }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${path} failed (${res.status})`);
  return data;
};

/**
 * Keep a session attached to its project's storybook: an SSE stream that
 * reconnects by itself, and delivers what the person does there.
 */
export const attachSession = (base: string, id: string, label: string, on: (event: string, data: unknown) => void): (() => void) => {
  const controller = new AbortController();
  const loop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(`${base}__session?id=${encodeURIComponent(id)}&label=${encodeURIComponent(label)}`, { signal: controller.signal });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        const pending = { buffer: '' };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending.buffer += decoder.decode(value, { stream: true });
          const blocks = pending.buffer.split('\n\n');
          pending.buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const raw = /^data: (.+)$/m.exec(block)?.[1];
            if (event) on(event, raw ? JSON.parse(raw) : undefined);
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      // The daemon restarted or the network blinked: try again shortly.
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  };
  void loop();
  return () => controller.abort();
};
