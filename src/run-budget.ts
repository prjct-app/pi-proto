export type RunUsage = { calls: number; tools: number; input: number; output: number; cacheRead: number };
export type RunLimits = { seconds: number; calls: number; tools: number; output: number };
export const DEFAULT_RUN_LIMITS: Readonly<RunLimits> = { seconds: 180, calls: 12, tools: 24, output: 16_000 };
export class RunBudget {
  readonly usage: RunUsage = { calls: 0, tools: 0, input: 0, output: 0, cacheRead: 0 };
  readonly startedAt = Date.now();
  stopped = false;
  constructor(readonly limits: Readonly<RunLimits> = DEFAULT_RUN_LIMITS) {}
  message(usage: { input?: number; output?: number; cacheRead?: number }): void {
    this.usage.calls += 1; this.usage.input += usage.input ?? 0; this.usage.output += usage.output ?? 0; this.usage.cacheRead += usage.cacheRead ?? 0;
  }
  reason(now = Date.now()): string | undefined {
    if (now - this.startedAt >= this.limits.seconds * 1000) return `${this.limits.seconds}s time limit`;
    if (this.usage.calls >= this.limits.calls) return `${this.limits.calls} model-call limit`;
    if (this.usage.tools >= this.limits.tools) return `${this.limits.tools} tool-call limit`;
    if (this.usage.output >= this.limits.output) return `${this.limits.output} generated-token limit`;
    return undefined;
  }
}
