/** Consume pi-memory's published, project-bound, read-only view. Never open a second database. */
type View = (request: { role: 'worker'; query: string; maxBytes: number; signal: AbortSignal }) => Promise<{ text: string }>;
const KEY = Symbol.for('prjct.memory');
export const designMemory = async (query: string, timeoutMs = 500): Promise<{ status: 'available' | 'empty' | 'unavailable' | 'timeout'; text: string }> => {
  const host = (globalThis as unknown as Record<symbol, { childView?: View } | undefined>)[KEY];
  if (!host?.childView) return { status: 'unavailable', text: 'pi-memory is not loaded. No previous decisions were retrieved; do not claim otherwise.' };
  const controller = new AbortController();
  const clock: { timer?: NodeJS.Timeout } = {};
  const timeout = new Promise<{ status: 'timeout'; text: string }>(resolve => {
    clock.timer = setTimeout(() => { controller.abort(); resolve({ status: 'timeout', text: 'Memory lookup timed out; use the current guide and inspect memory_context only if a decision is missing.' }); }, timeoutMs);
  });
  try {
    return await Promise.race([host.childView({ role: 'worker', query: `${query.slice(0, 600)} design visual identity layout typography reuse decisions rejected patterns`, maxBytes: 1_500, signal: controller.signal })
      .then(result => ({ status: result.text ? 'available' as const : 'empty' as const, text: result.text ? result.text.slice(0, 3_200) : 'No supported design memory retrieved for this project.' }))
      .catch(() => ({ status: 'unavailable' as const, text: 'Memory lookup failed. Do not invent prior decisions.' })), timeout]);
  } finally { clearTimeout(clock.timer); controller.abort(); }
};
