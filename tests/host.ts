import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, ToolDefinition, RegisteredCommand } from '@earendil-works/pi-coding-agent';
import { installProto, type ProtoController } from '../src/host.ts';

export type ToolRegistration = ToolDefinition;
export type CommandRegistration = Omit<RegisteredCommand, 'name' | 'sourceInfo'>;

export type FakePi = {
  pi: ExtensionAPI;
  controller: ProtoController;
  hooks: Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>>;
  tools: Map<string, ToolRegistration>;
  commands: Map<string, CommandRegistration>;
  events: { invoked: string[]; sent: Array<{ message: unknown; options: unknown }>; typed: Array<{ content: unknown; options: unknown }> };
};

const fakeUi = (): ExtensionUIContext => {
  const noop = (): void => undefined;
  const asyncNoop = async (): Promise<undefined> => undefined;
  return new Proxy({} as ExtensionUIContext, {
    get: (_target, prop) => {
      if (prop === 'select') return asyncNoop;
      if (prop === 'confirm') return asyncNoop;
      if (prop === 'input') return asyncNoop;
      if (prop === 'notify') return noop;
      if (prop === 'setStatus') return noop;
      if (prop === 'setWorkingMessage') return noop;
      if (prop === 'setWorkingVisible') return noop;
      if (prop === 'onTerminalInput') return asyncNoop;
      if (prop === 'offTerminalInput') return noop;
      return noop;
    },
  });
};

const makeCtx = (cwd: string): ExtensionContext => {
  return {
    cwd,
    hasUI: false,
    ui: fakeUi(),
    mode: 'tui',
  } as unknown as ExtensionContext;
};

export const makeFakePi = (cwd: string): FakePi => {
  const hooks = new Map<string, Array<(event: unknown, c: ExtensionContext) => Promise<unknown> | unknown>>();
  const tools = new Map<string, ToolRegistration>();
  const commands = new Map<string, CommandRegistration>();
  const events: FakePi['events'] = { invoked: [], sent: [], typed: [] };

  const pi: ExtensionAPI = {
    on(event: string, handler: (event: unknown, c: ExtensionContext) => Promise<unknown> | unknown) {
      const arr = hooks.get(event) ?? [];
      arr.push(handler);
      hooks.set(event, arr);
    },
    registerTool(tool: ToolRegistration) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, spec: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) {
      commands.set(name, spec as CommandRegistration);
    },
    sendMessage: (message: unknown, options: unknown) => { events.invoked.push('sendMessage'); events.sent.push({ message, options }); },
    registerMessageRenderer: () => undefined,
    sendUserMessage: (content: unknown, options: unknown) => { events.invoked.push('sendUserMessage'); events.typed.push({ content, options }); },
    appendEntry: () => events.invoked.push('appendEntry'),
    getContext: () => ({ cwd, mode: 'interactive' }),
    setContext: () => events.invoked.push('setContext'),
    exec: async () => '',
  } as unknown as ExtensionAPI;

  const controller = installProto(pi, { skipRegister: false });
  return { pi, controller, hooks, tools, commands, events };
};

export const fire = async <T>(hooks: Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<T> | T>>, name: string, event: unknown, cwd: string): Promise<T | undefined> => {
  const handlers = hooks.get(name) ?? [];
  const c = makeCtx(cwd);
  for (const h of handlers) {
    const result = await h(event, c);
    if (result !== undefined) return result as T;
  }
  return undefined;
};

export { installProto };
