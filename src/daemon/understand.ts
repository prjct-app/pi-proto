import type { Questions } from '@typesafe-ai/sdk';
import type { Node, Prototype } from '../spec/schema.ts';

/**
 * Jev reads what the person typed in the composer before any agent does. In
 * about 300 ms it says what they want (open a page, undo, change something,
 * restyle the whole design line, ask) and which page and element they mean.
 * The storybook acts on that at once: it opens the page or undoes without
 * waking the agent, and it marks the element it understood while the agent
 * starts. Jev never writes anything and never blocks: without a key, on a
 * timeout or an error, the message goes to the agent exactly as it was.
 */

/** Pinned like pi-qa, pi-mcp and pi-memory: a silent model swap would move every threshold. */
export const JEV_MODEL = 'jev-1.13.0';
/** An answer later than this is worth less than the agent starting now. */
export const UNDERSTAND_TIMEOUT_MS = 1_500;

type ChoiceAnswer = Readonly<{ type: 'choice'; choice: string; confidence: number }>;
export type Jev = (state: unknown, questions: Questions, signal?: AbortSignal) => Promise<Readonly<Record<string, ChoiceAnswer | undefined>>>;

/** The one TypeSafe key every prjct extension shares: TYPESAFE_API_KEY, then the OS keyring. */
export const connectJev = async (): Promise<Jev | undefined> => {
  // Tests and offline runs never reach the keyring or the network.
  if (process.env.PI_PROTO_OFFLINE === '1') return undefined;
  try {
    const [kit, { AsyncEntry }, { TypeSafeClient }] = await Promise.all([
      import('@prjct.app/pi-tui-kit'), import('@napi-rs/keyring'), import('@typesafe-ai/sdk')]);
    const resolved = await kit.resolveKey(kit.keyringStoreFromEntries(new AsyncEntry(kit.KEYRING_SERVICE, kit.KEYRING_ACCOUNT)));
    if (!resolved.key) return undefined;
    const client = new TypeSafeClient({ apiKey: resolved.key, defaultModel: JEV_MODEL, logLevel: 'off', timeout: UNDERSTAND_TIMEOUT_MS, retry: { maxRetries: 0 } });
    return async (state, questions, signal) =>
      (await client.systemOne({ state: state as never, questions }, { signal })).answers as unknown as Record<string, ChoiceAnswer>;
  } catch {
    return undefined;
  }
};

export type Intent = 'navigate' | 'undo' | 'change' | 'system' | 'question';

const INTENTS: Record<Intent, string> = {
  navigate: 'Only wants to see or open a page of the prototype; nothing should change.',
  undo: 'Only wants to undo exactly the last prototype change. No additional edits, specific older version, scoped partial reversal or navigation.',
  change: 'Wants to change the prototype: edit, add, remove or move elements or pages.',
  system: 'Wants a change to the whole design line: colors, typography, spacing, radius or the style of every element of a kind.',
  question: 'Asks something or wants an opinion; nothing should change yet.',
};

/** Below these, the storybook does nothing on its own and the agent decides. */
export const THRESHOLDS = { navigate: 0.8, page: 0.75, undo: 0.85, node: 0.6 } as const;

const NONE = 'none';
const MAX_PAGES = 200;
const MAX_NODES = 150;
/** A message this long is a brief for the agent, not a command for the storybook. */
const MAX_TEXT = 1_000;

export type Understood = Readonly<{
  intent: Intent;
  confidence: number;
  /** The page the message names, when it names one with confidence. */
  page?: Readonly<{ prototype: string; page: string; title: string }>;
  /** The element on the current page the message talks about, when nothing was selected. */
  node?: Readonly<{ id: string; label: string; prototype: string; page: string }>;
}>;

export const labelOf = (node: Node): string =>
  (node.text ?? node.alt ?? node.placeholder ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

const flatten = (nodes: readonly Node[] | undefined, out: Node[] = []): Node[] => {
  for (const node of nodes ?? []) { out.push(node); flatten(node.children, out); }
  return out;
};

export type UnderstandInput = Readonly<{
  text: string;
  prototypes: readonly Prototype[];
  /** Where the person is: the prototype and page on screen. */
  current?: Readonly<{ prototype: string; page?: string }>;
  /** True when the person already picked an element: Jev does not guess one. */
  selected: boolean;
}>;

/**
 * One Jev request with every question on it (billed once for the state): the
 * intent, the page it names, and the element it means. Undefined when there
 * is nothing Jev could add.
 */
export const understand = async (jev: Jev, input: UnderstandInput, signal?: AbortSignal): Promise<Understood | undefined> => {
  const text = input.text.trim();
  if (!text || text.length > MAX_TEXT) return undefined;
  const current = input.prototypes.find(p => p.id === input.current?.prototype);
  const ordered = current ? [current, ...input.prototypes.filter(p => p !== current)] : [...input.prototypes];
  const pages = ordered.flatMap(p => p.pages.map(page => ({ key: `${p.id}/${page.id}`, prototype: p.id, page: page.id, title: page.title, label: `${p.title} › ${page.title}${page.flow ? ` (${page.flow})` : ''}` }))).slice(0, MAX_PAGES);
  const page = current?.pages.find(p => p.id === input.current?.page) ?? current?.pages[0];
  // Qualify ids: variants often have the same node ids. Include other pages
  // so a request about "the title on Pago" cannot pick the current title.
  const nodePages = ordered.flatMap(p => p.pages.map(pg => ({ prototype: p.id, page: pg })));
  const sorted = [...nodePages.filter(p => p.prototype === current?.id && p.page.id === page?.id),
    ...nodePages.filter(p => p.prototype !== current?.id || p.page.id !== page?.id)];
  const nodes = input.selected ? [] : sorted.flatMap(p => flatten(p.page.children).map(n => ({
    key: `${p.prototype}/${p.page.id}/${n.id}`, id: n.id, prototype: p.prototype, page: p.page.id,
    kind: `${n.type}${n.as ? ` ${n.as}` : ''}`, label: labelOf(n), pageTitle: p.page.title,
  }))).slice(0, MAX_NODES);

  const questions: Questions = {
    intent: { type: 'choice', instructions: 'What does the message ask for?', criteria: INTENTS },
  };
  if (pages.length) {
    questions['page'] = { type: 'choice', instructions: 'Which page does the message name or mean? "none" if it names no page.', criteria: { ...Object.fromEntries(pages.map(p => [p.key, p.label])), [NONE]: 'No page is named.' } };
  }
  if (nodes.length) {
    questions['node'] = { type: 'choice', instructions: 'Which single element does the message talk about? Use the current page unless another page is explicitly named. "none" if ambiguous or several elements.', criteria: { ...Object.fromEntries(nodes.map(n => [n.key, `${n.pageTitle} › ${n.kind}: ${n.label || n.id}`])), [NONE]: 'No single element, or several.' } };
  }
  const state = {
    note: 'A person is editing a UI prototype and wrote this message, usually in Spanish.',
    message: text,
    current_page: page ? `${page.title} (${page.id})` : null,
  };

  const answers = await jev(state, questions, signal);
  const intent = answers['intent'];
  const valid = (answer: ChoiceAnswer | undefined): answer is ChoiceAnswer =>
    answer?.type === 'choice' && Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1;
  if (!valid(intent) || !Object.hasOwn(INTENTS, intent.choice)) return undefined;
  const pageAnswer = answers['page'];
  const pickedPage = valid(pageAnswer) && pageAnswer.choice !== NONE && pageAnswer.confidence >= THRESHOLDS.page ? pages.find(p => p.key === pageAnswer.choice) : undefined;
  const nodeAnswer = answers['node'];
  const candidate = valid(nodeAnswer) && nodeAnswer.choice !== NONE && nodeAnswer.confidence >= THRESHOLDS.node ? nodes.find(n => n.key === nodeAnswer.choice) : undefined;
  const pickedNode = candidate && (pickedPage
    ? candidate.prototype === pickedPage.prototype && candidate.page === pickedPage.page
    : candidate.prototype === current?.id && candidate.page === page?.id) ? candidate : undefined;
  return {
    intent: intent.choice as Intent,
    confidence: intent.confidence,
    ...(pickedPage ? { page: { prototype: pickedPage.prototype, page: pickedPage.page, title: pickedPage.title } } : {}),
    ...(pickedNode ? { node: { id: pickedNode.id, label: pickedNode.label, prototype: pickedNode.prototype, page: pickedNode.page } } : {}),
  };
};
