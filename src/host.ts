import { repairToolArgs } from '@prjct.app/pi-tui-kit';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveProtoProject, type ResolvedProject } from './project.ts';
import { StatusFile } from './status.ts';
import { guard } from './guard.ts';
import { registerTools } from './tools.ts';
import { registerCommand } from './commands.ts';
import { showStatus } from './modes.ts';
import { attachSession, call, daemon } from './client.ts';
import { initWorkspace, type InitArtifact } from './spec/init.ts';
import { taskScope, scopeViolation, scopeFileViolation, type TaskScope } from './scope.ts';
import { classifyBash } from './bash.ts';
import { changePi, imagesOf, piState, replyText, stepOf, userContent, type AgentState, type TargetContext } from './session-bridge.ts';
import { DESIGNER_PROMPT, DESIGNER_TYPE, hasDesignerMessage, isDesignRequest } from './designer.ts';
import { DEFAULT_RUN_LIMITS, RunBudget, type RunLimits } from './run-budget.ts';

/**
 * pi-proto in a Pi session: a thin client of the proto daemon. The daemon
 * holds the storybook, its live events and the versioned YAML; this session is
 * the engine. What the person types in the storybook arrives here as their
 * message; what the agent is doing, its model and its answer go back.
 */

export type ProtoOptions = Readonly<{ skipRegister?: boolean; runLimits?: Partial<RunLimits> }>;

export type Connection = Readonly<{ base: string; project: ResolvedProject }>;

export type ProtoController = Readonly<{
  /** The project of the session's folder. */
  project(): Promise<ResolvedProject | undefined>;
  /** The daemon URL for this project's storybook, starting the daemon (and creating the workspace with `init`). */
  connect(options?: { init?: boolean; artifact?: InitArtifact; passive?: boolean }): Promise<Connection>;
  scope(): TaskScope;
  context(options?: { frontend?: string; refresh?: boolean }): Promise<string>;
  /** Manually run the guard for a tool call (tests use this). */
  guard(input: { toolName: string; input: unknown }): ReturnType<typeof guard>;
  /** Say something in the storybook's conversation, as this session's agent. */
  say(text: string): void;
}>;

const hasWorkspace = (project: ResolvedProject): boolean => existsSync(join(project.protoDir, 'proto.json'));

export const installProto = (pi: ExtensionAPI, options: ProtoOptions = {}): ProtoController => {
  repairToolArgs(pi);
  const ctxRef: { current: ExtensionContext | undefined } = { current: undefined };
  const sessionId = `${process.pid}-${Date.now().toString(36)}`;
  const state: {
    resolved?: Promise<ResolvedProject | undefined>;
    connection?: Connection;
    connecting?: Promise<Connection>;
    detach?: () => void;
    fromStorybook: boolean;
    agent: AgentState;
    designerSent: boolean;
    heartbeat?: NodeJS.Timeout;
    lastPreviewAt?: number;
    scope?: TaskScope;
    request?: string;
    snapshot?: string;
    run?: RunBudget;
    runTimer?: NodeJS.Timeout;
  } = { fromStorybook: false, agent: { state: 'idle' }, designerSent: false };

  const designerMessage = () => ({ customType: DESIGNER_TYPE, content: DESIGNER_PROMPT, display: false });
  const needsDesigner = (): boolean => !state.designerSent && !hasDesignerMessage(ctxRef.current);
  const announceDesigner = (): void => {
    if (!needsDesigner()) return;
    state.designerSent = true;
    pi.sendMessage(designerMessage(), { triggerTurn: false, deliverAs: 'nextTurn' });
  };

  const project = (): Promise<ResolvedProject | undefined> => {
    state.resolved ??= resolveProtoProject(ctxRef.current?.cwd ?? process.cwd()).catch(() => undefined);
    return state.resolved;
  };

  /** Tell the storybook about this session; quiet when it is not connected. */
  const reporting = { pending: Promise.resolve() };
  const report = (body: Record<string, unknown>): void => {
    const c = state.connection;
    if (c) reporting.pending = reporting.pending.then(async () => {
      await call(c.base, '__session/report', { id: sessionId, ...body });
    }).catch(() => undefined);
  };
  const setAgent = (agent: AgentState): void => { state.agent = agent; report({ agent }); };
  const metered = (agent: AgentState): AgentState => state.run ? { ...agent, usage: { ...state.run.usage }, limits: state.run.limits } : agent;
  const stopRun = (reason: string): void => {
    if (!state.run || state.run.stopped) return;
    state.run.stopped = true; clearTimeout(state.runTimer);
    const message = `Prototype stopped: ${reason}. Saved work is preserved. Review the partial result before requesting more work; nothing was reverted.`;
    report({ reply: message }); setAgent({ ...metered({ state: 'idle' }), stopped: reason });
    ctxRef.current?.ui?.notify?.(message, 'warning'); ctxRef.current?.abort?.();
  };
  const startRun = (): void => {
    clearTimeout(state.runTimer); state.run = new RunBudget({ ...DEFAULT_RUN_LIMITS, ...options.runLimits });
    state.runTimer = setTimeout(() => stopRun(state.run!.reason() ?? 'time limit'), state.run.limits.seconds * 1000);
    state.runTimer.unref();
  };
  const context = async (opts: { frontend?: string; refresh?: boolean } = {}): Promise<string> => {
    const p = await project(); if (!p) return 'No project resolved. Do not invent repository design decisions.';
    const [{ projectContext }, { designMemory }] = await Promise.all([import('./project-context.ts'), import('./memory-context.ts')]);
    const [source, memory] = await Promise.all([projectContext(p, opts), designMemory(state.request ?? '')]);
    const limits = state.run?.limits ?? DEFAULT_RUN_LIMITS;
    return `${source.text}\n\nProject memory: ${memory.status}\n${memory.text}\n\nRequested artifact scope: ${state.scope ?? 'follow the explicit screen/task request'}. New screens must extend the design reasoning, not copy a bad baseline.\nTask budget: ${limits.seconds}s, ${limits.calls} model responses, ${limits.tools} tool calls, ${limits.output} generated tokens. Batch work; no speculative extra deliverables.`;
  };

  const onEvent = async (event: string, data: unknown): Promise<void> => {
    if (event === 'hello') {
      report({ pi: piState(pi, ctxRef.current), agent: state.agent });
      return;
    }
    if (event === 'ask') {
      const ask = data as { text?: string; images?: unknown; target?: unknown; viewing?: unknown; context?: TargetContext; artifact?: string };
      const text = (ask.text ?? '').trim();
      state.scope = taskScope(text);
      state.request = text;
      const images = imagesOf(ask.images);
      if (!text && !images.length) return;
      const idle = ctxRef.current?.isIdle?.() ?? true;
      const content = userContent(text, ask.target ?? ask.viewing, images, ask.context, ask.artifact);
      state.scope = taskScope(content[0]!.type === 'text' ? content[0]!.text : text);
      if (!idle) { startRun(); state.snapshot = await context().catch(() => state.snapshot); }
      announceDesigner();
      state.fromStorybook = true;
      // As if typed in Pi's editor: an idle agent starts on it, a busy one is steered.
      pi.sendUserMessage(content, idle ? undefined : { deliverAs: 'steer' });
      setAgent({ state: 'working', step: idle ? 'Pensando' : 'En cola para el agente', startedAt: idle ? Date.now() : state.agent.startedAt ?? Date.now() });
    }
    if (event === 'pi-change') {
      const next = await changePi(pi, ctxRef.current, data).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
      report('error' in next ? { pi: { ...piState(pi, ctxRef.current), error: next.error } } : { pi: next });
    }
  };

  const connect = async (opts: { init?: boolean; artifact?: InitArtifact; passive?: boolean } = {}): Promise<Connection> => {
    if (opts.init) {
      const artifact = opts.artifact ?? (state.scope === 'foundation' ? 'workspace' : state.scope) ?? 'workspace';
      const violation = scopeViolation(state.scope, 'proto_init', { artifact });
      if (violation) throw new Error(violation);
      state.resolved = Promise.resolve((await initWorkspace(ctxRef.current?.cwd ?? process.cwd(), 'agent', { artifact })).project);
    }
    if (!opts.passive) announceDesigner();
    if (state.connection) return state.connection;
    state.connecting ??= (async () => {
      const cwd = ctxRef.current?.cwd ?? process.cwd();
      const p = await project();
      if (!p) throw new Error('this folder is not a project pi-proto can resolve.');
      if (!hasWorkspace(p)) throw new Error('this project has no design workspace yet; call proto_init.');
      const alive = await daemon();
      const connection = { base: `${alive.url}/${p.projectId}/`, project: p };
      state.connection = connection;
      const label = `${ctxRef.current?.cwd?.split(sep).pop() ?? 'Pi'} · pid ${process.pid}`;
      state.detach = attachSession(connection.base, sessionId, label, (event, data) => void onEvent(event, data).catch(error => {
        setAgent({ state: 'idle' }); report({ reply: `No se pudo enviar a Pi: ${error instanceof Error ? error.message : String(error)}` });
      }));
      // The hub knows the session once its stream is open; tell it the model right after.
      state.heartbeat = setInterval(() => {
        if (ctxRef.current?.isIdle?.() && state.agent.state === 'working') state.agent = { state: 'idle' };
        report({ pi: piState(pi, ctxRef.current), agent: state.agent });
      }, 10_000);
      state.heartbeat.unref();
      // Only this folder's project: another project's storybook never shows here.
      return connection;
    })().finally(() => { state.connecting = undefined; });
    return state.connecting;
  };

  const controller: ProtoController = {
    project,
    scope: () => state.scope,
    context,
    connect,
    say: text => report({ reply: text }),
    async guard(input) {
      const p = await project();
      if (!p) return undefined;
      return guard({ toolName: input.toolName, input: input.input, projectRoot: p.location, protoDir: p.protoDir, config: await new StatusFile(p.protoDir).read() });
    },
  };

  if (options.skipRegister) return controller;

  pi.on('session_start', async (_event, ctx) => {
    clearTimeout(state.runTimer); state.run = undefined; state.snapshot = undefined;
    clearInterval(state.heartbeat);
    state.detach?.();
    state.detach = undefined;
    state.connection = undefined;
    state.designerSent = false;
    state.fromStorybook = false;
    state.scope = undefined;
    state.request = undefined;
    ctxRef.current = ctx;
    // Clear obsolete idle/live indicators left by earlier versions. Prototype has no idle TUI status.
    showStatus(ctx, undefined);
    state.resolved = undefined;
    const p = await project();
    // A project with a workspace connects to its storybook by itself; not awaited.
    if (p && hasWorkspace(p)) void connect({ passive: true }).catch(() => undefined);
  });

  pi.on('before_agent_start', async (event, ctx) => {
    ctxRef.current = ctx;
    state.scope = taskScope(event.prompt);
    state.request = event.prompt;
    if (state.fromStorybook || isDesignRequest(event.prompt)) {
      startRun(); state.snapshot = await context().catch(() => 'Project context could not be loaded. Inspect the relevant source only; do not reconstruct the repository blindly.');
    } else { clearTimeout(state.runTimer); state.run = undefined; state.snapshot = undefined; }
    if (!needsDesigner()) return undefined;
    if (!isDesignRequest(event.prompt)) return undefined;
    state.designerSent = true;
    return { message: designerMessage() };
  });

  pi.on('input', async event => { state.scope = taskScope(event.text); state.request = event.text; });
  pi.on('context', async event => {
    // Only our own superseded instructions are removed from model context.
    // Keep the session journal and all user/assistant/tool evidence untouched.
    const keep = { designer: false };
    const messages = event.messages.filter(message => {
      if (message.role === 'custom' && message.customType === 'proto-context') return false;
      if (message.role !== 'custom' || message.customType !== DESIGNER_TYPE) return true;
      if (message.content !== DESIGNER_PROMPT || keep.designer) return false;
      keep.designer = true; return true;
    });
    if (state.snapshot && state.run && !state.run.stopped) messages.push({ role: 'custom', customType: 'proto-context', content: state.snapshot, display: false, timestamp: Date.now() });
    return { messages };
  });

  pi.on('session_shutdown', async () => {
    clearTimeout(state.runTimer);
    clearInterval(state.heartbeat);
    state.detach?.();
    state.detach = undefined;
    state.connection = undefined;
    showStatus(ctxRef.current, undefined);
    ctxRef.current = undefined;
  });

  pi.on('tool_call', async (event, ctx) => {
    ctxRef.current = ctx;
    const exhausted = state.run?.reason();
    if (exhausted && !['answer', 'proto_reply', 'memory_record'].includes(event.toolName)) { stopRun(exhausted); return { block: true, reason: `Prototype task budget exceeded: ${exhausted}. Report the saved partial result; do not continue.` }; }
    const violation = scopeViolation(state.scope, event.toolName, event.input);
    if (violation) return { block: true, reason: violation };
    const p = await project();
    if (!p) return undefined;
    // The YAML is changed through operations, or its versions and the live page break.
    const input = event.input as { path?: unknown; file_path?: unknown };
    const target = typeof input?.path === 'string' ? input.path : typeof input?.file_path === 'string' ? input.file_path : undefined;
    if ((event.toolName === 'write' || event.toolName === 'edit') && target) {
      const scopeError = scopeFileViolation(state.scope, target, state.request ?? '');
      if (scopeError) return { block: true, reason: scopeError };
      const file = resolve(ctx.cwd, target);
      if (file.startsWith(join(p.protoDir, 'prototypes') + sep) && file.endsWith('.yaml')) {
        return { block: true, reason: 'Prototypes are versioned YAML: change them with proto_edit (operations on node ids), not by writing the file.' };
      }
    }
    if (state.scope && event.toolName === 'bash') {
      const command = String((event.input as { command?: string }).command ?? '');
      for (const path of classifyBash(command).paths) {
        const scopeError = scopeFileViolation(state.scope, path, state.request ?? '');
        if (scopeError) return { block: true, reason: scopeError };
      }
      if (/api\/(?:ops|create_page|create_prototype|revert)/.test(command)) return { block: true, reason: 'Prototype writes via shell are outside this tokens/document-only request.' };
    }
    const decision = await guard({ toolName: event.toolName, input: event.input, projectRoot: p.location, protoDir: p.protoDir, config: await new StatusFile(p.protoDir).read() });
    return decision?.block ? { block: true, reason: decision.reason ?? 'proto guard blocked this write.' } : undefined;
  });

  // What the agent is doing, for the storybook's working indicator.
  pi.on('agent_start', async (_event, ctx) => { ctxRef.current = ctx; state.lastPreviewAt = undefined; setAgent(metered({ state: 'working', step: 'Thinking', startedAt: Date.now() })); });
  pi.on('turn_start', async () => { const reason = state.run?.reason(); if (reason) { stopRun(reason); return; } setAgent(metered({ ...state.agent, state: 'working', step: 'Thinking' })); });
  pi.on('tool_execution_start', async event => { if (state.run) state.run.usage.tools += 1; setAgent(metered({ ...state.agent, state: 'working', step: stepOf(event.toolName, event.args) })); });
  pi.on('message_end', async event => { if (state.run && event.message.role === 'assistant') { state.run.message(event.message.usage); setAgent(metered(state.agent)); } });
  pi.on('tool_execution_end', async event => {
    if (state.snapshot && !event.isError && ['proto_design', 'proto_tokens'].includes(event.toolName)) state.snapshot = await context().catch(() => state.snapshot);
  });
  pi.on('message_update', async event => {
    if (event.assistantMessageEvent.type !== 'text_delta') return;
    if (Date.now() - (state.lastPreviewAt ?? 0) < 150) return;
    state.lastPreviewAt = Date.now();
    const content = event.assistantMessageEvent.partial.content;
    const text = content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (state.fromStorybook) report({ preview: text.slice(-16_000) });
  });
  pi.on('agent_end', async event => {
    clearTimeout(state.runTimer); setAgent(metered({ state: 'idle', ...(state.run?.stopped ? { stopped: state.agent.stopped } : {}) }));
    if (!state.fromStorybook) return;
    state.fromStorybook = false;
    if (state.run?.stopped) return;
    const text = replyText(event.messages as unknown[]);
    if (text) report({ reply: text });
  });
  pi.on('model_select', async () => report({ pi: piState(pi, ctxRef.current) }));
  pi.on('thinking_level_select', async () => report({ pi: piState(pi, ctxRef.current) }));

  registerTools(pi, controller);
  registerCommand(pi, controller);
  return controller;
};

export default function (pi: ExtensionAPI): void {
  installProto(pi);
}
