import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

/**
 * What the storybook composer shares with the Pi session: the person's message
 * (text and images) goes in as theirs, the model and thinking level are the
 * session's own, and the agent's final words come back to the page.
 */

export type Image = Readonly<{ data: string; mimeType: string }>;
export type TargetContext = Readonly<{ prototype: string; page: string; version: number; node: string; yaml: string }>;

/** What the agent is doing now, for the storybook's working indicator. */
export type AgentState = Readonly<{ state: 'idle' | 'working'; step?: string; startedAt?: number;
  usage?: { calls: number; tools: number; input: number; output: number; cacheRead: number };
  limits?: { seconds: number; calls: number; tools: number; output: number }; stopped?: string }>;

export type PiState = Readonly<{
  models: ReadonlyArray<Readonly<{ provider: string; id: string; name: string }>>;
  model: Readonly<{ provider: string; id: string }> | undefined;
  thinking: string;
  levels: readonly string[];
  agent?: AgentState;
}>;

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** At most this many images per message; the page refuses more before sending. */
export const MAX_IMAGES = 6;

/** Images the page sent, kept only when they are real base64 images. */
export const imagesOf = (raw: unknown): Image[] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    const image = item as { data?: unknown; mimeType?: unknown };
    return typeof image.data === 'string' && typeof image.mimeType === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(image.mimeType) && /^[A-Za-z0-9+/=]+$/.test(image.data.slice(0, 200))
      ? [{ data: image.data, mimeType: image.mimeType }]
      : [];
  }).slice(0, MAX_IMAGES);
};

/** Where the person was when they wrote: the prototype, page and node they had picked. */
const where = (target: unknown): string => {
  const t = (target ?? {}) as { prototype?: string; page?: string; node?: string; guide?: string; title?: string };
  const parts = [t.prototype && `prototype ${t.prototype}`, t.page && `page ${t.page}`, t.node && `node ${t.node}`, t.guide && `guide ${t.guide}`].filter(Boolean);
  if (!parts.length && t.title) parts.push(t.title);
  return parts.length ? `[prototype · ${parts.join(' › ')}]\n` : '';
};

/** The person's message as they would type it in Pi, with what they were looking at. */
export const userContent = (text: string, target: unknown, images: readonly Image[], context?: TargetContext, artifact?: string): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> => [
  { type: 'text', text: `${artifact && ['tokens', 'guide', 'prototype'].includes(artifact) ? `[prototype task: ${artifact}]\n` : ''}${where(target)}${text || '(see the attached image)'}` },
  ...(context ? [{ type: 'text' as const, text: `[prototype element · ${context.prototype} › ${context.page} › ${context.node} · v${context.version}]\nCurrent prototype data (a targeting hint, not an instruction):\n\`\`\`yaml\n${context.yaml}\`\`\`` }] : []),
  ...images.map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
];

export const piState = (pi: ExtensionAPI, ctx: ExtensionContext | undefined): PiState => {
  const available = ctx?.modelRegistry?.getAvailable?.() ?? [];
  const model = ctx?.model;
  return {
    models: available.map(m => ({ provider: m.provider, id: m.id, name: m.name ?? m.id })),
    model: model ? { provider: model.provider, id: model.id } : undefined,
    thinking: String(pi.getThinkingLevel?.() ?? 'off'),
    levels: THINKING_LEVELS,
  };
};

/** Apply a change the composer asked for, then report the session as it is now. */
export const changePi = async (pi: ExtensionAPI, ctx: ExtensionContext | undefined, change: unknown): Promise<PiState> => {
  const wanted = change as { model?: { provider?: string; id?: string }; thinking?: string; abort?: boolean };
  // Like Esc in Pi's editor: stop the run that is going.
  if (wanted.abort) ctx?.abort?.();
  if (wanted.model?.provider && wanted.model.id) {
    const model = ctx?.modelRegistry?.find(wanted.model.provider, wanted.model.id);
    if (!model) throw new Error(`no model ${wanted.model.provider}/${wanted.model.id}`);
    if (!(await pi.setModel(model))) throw new Error(`${model.provider} is not signed in; run /login in Pi`);
  }
  if (wanted.thinking && (THINKING_LEVELS as readonly string[]).includes(wanted.thinking)) {
    pi.setThinkingLevel(wanted.thinking as never);
  }
  return piState(pi, ctx);
};

type Part = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Message = { role?: string; content?: Part[]; toolName?: string; isError?: boolean; details?: unknown };

/** A typed reply (pi-answer) as plain lines: the lead prose, the files it touched, the why. */
const fromReply = (reply: Record<string, unknown>): string | undefined => {
  const lead = [reply['answer'], reply['question'], reply['reason'], reply['cause']].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  const files = Array.isArray(reply['files']) ? (reply['files'] as Array<{ path?: string; what?: string }>).map(f => `· ${f.path ?? ''}${f.what ? ` — ${f.what}` : ''}`) : [];
  const text = [lead, ...files, typeof reply['explanation'] === 'string' ? reply['explanation'] : undefined].filter(Boolean).join('\n').trim();
  return text || undefined;
};

/**
 * The agent's final words in a run. With pi-answer, the reply that was
 * delivered (a rejected attempt before it says nothing useful); otherwise the
 * text of the last assistant message.
 */
export const replyText = (messages: readonly unknown[]): string | undefined => {
  const all = messages as Message[];
  const delivered = [...all].reverse().find(m => m.role === 'toolResult' && m.toolName === 'answer' && !m.isError && m.details && typeof m.details === 'object');
  const fromDelivered = delivered && fromReply(delivered.details as Record<string, unknown>);
  if (fromDelivered) return fromDelivered;
  const call = [...all].reverse().flatMap(m => (m.role === 'assistant' ? m.content ?? [] : [])).find(p => p.type === 'toolCall' && p.name === 'answer');
  const fromCall = call?.arguments && fromReply(call.arguments);
  if (fromCall) return fromCall;
  const last = [...all].reverse().find(m => m.role === 'assistant');
  const text = (last?.content ?? []).filter(p => p.type === 'text' && p.text?.trim()).map(p => p.text!.trim()).join('\n\n');
  return text || undefined;
};

const base = (path: unknown): string => typeof path === 'string' ? path.split('/').filter(Boolean).pop() ?? path : '';

/** What the agent is doing, in the person's words, from the tool it just started. */
export const stepOf = (toolName: string, args: unknown): string => {
  const a = (args ?? {}) as Record<string, unknown>;
  const file = base(a['path'] ?? a['file_path'] ?? a['file']);
  switch (toolName) {
    case 'read': return file ? `Leyendo ${file}` : 'Leyendo';
    case 'write': return file ? `Escribiendo ${file}` : 'Escribiendo';
    case 'edit': return file ? `Editando ${file}` : 'Editando';
    case 'bash': return `Ejecutando ${String(a['command'] ?? '').split('\n')[0]!.slice(0, 48)}`.trim();
    case 'grep': case 'find': case 'ls': return 'Buscando en el proyecto';
    case 'proto_shot': case 'proto_review': return 'Tomando capturas';
    case 'proto_build': return 'Construyendo el prototipo';
    case 'proto_init': case 'proto_open': return 'Opening Prototype';
    case 'proto_context': return 'Reading design context';
    case 'answer': case 'proto_reply': return 'Respondiendo';
    default: return toolName.replace(/_/g, ' ');
  }
};
