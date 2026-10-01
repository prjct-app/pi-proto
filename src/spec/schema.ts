/**
 * The source of a prototype is data, not HTML: prototypes/<id>.yaml holds its
 * pages and, in each page, a tree of nodes with stable ids. HTML is generated
 * from it. The agent and the storybook change it with small operations on one
 * node at a time, so a change costs a few lines, not a rewritten page.
 *
 * Nodes are spatial primitives, never page sections: a vocabulary of "hero",
 * "features" and "CTA" is a template engine forever.
 */

export const NODE_TYPES = ['box', 'stack', 'row', 'grid', 'text', 'image', 'button', 'input', 'textarea', 'link', 'icon', 'divider', 'html'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** What a click does: go to a page of the same prototype, show or hide a node, or go back. */
export type Action = { go: string } | { toggle: string } | { back: true };

export type Node = {
  id: string;
  type: NodeType;
  /** The HTML tag when the type's default does not fit: h1, p, nav, label… */
  as?: string;
  /** Tailwind classes; the design tokens are available as classes too (bg-brand, rounded-card). */
  class?: string;
  text?: string;
  src?: string;
  alt?: string;
  placeholder?: string;
  href?: string;
  /** Raw markup, only for type html: the escape hatch, not the norm. */
  html?: string;
  attrs?: Record<string, string>;
  /** Starts hidden: a modal or menu that a toggle shows. */
  hidden?: boolean;
  on?: { click?: Action };
  children?: Node[];
};

export type Page = {
  id: string;
  title: string;
  /** Pages with the same flow are shown together: "Compra", "Cuenta", "Variante B". */
  flow?: string;
  class?: string;
  children: Node[];
};

export type Status = 'draft' | 'review' | 'approved';

/** One change: what it did, who did it, and the operations that undo it. */
export type HistoryEntry = { v: number; at: string; by: string; did: string; undo: Op[] };

export type Prototype = {
  proto: 1;
  id: string;
  title: string;
  /** Prototypes with the same group are variants, compared side by side. */
  group?: string;
  description?: string;
  status?: Status;
  version: number;
  pages: Page[];
  history?: HistoryEntry[];
};

/** Fields of a node or page an operation may set; null removes a field. */
export type Fields = { [K in keyof Omit<Node, 'id' | 'children'>]?: Node[K] | null } & { title?: string | null; flow?: string | null };

export type Op =
  | { op: 'set'; id: string; fields: Fields }
  | { op: 'insert'; parent: string; index?: number; node: Node }
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; parent: string; index?: number }
  | { op: 'add_page'; page: Page; index?: number }
  | { op: 'remove_page'; id: string }
  | { op: 'set_prototype'; fields: { title?: string | null; group?: string | null; description?: string | null; status?: Status | null } };

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TAG = /^[a-z][a-z0-9-]{0,15}$/;

const nodeProblems = (node: unknown, at: string, seen: Set<string>): string[] => {
  const n = node as Node;
  if (!n || typeof n !== 'object') return [`${at}: must be a node`];
  const problems: string[] = [];
  if (typeof n.id !== 'string' || !ID.test(n.id)) problems.push(`${at}.id: must be a lowercase id`);
  else if (seen.has(n.id)) problems.push(`${at}.id: "${n.id}" is used twice`);
  else seen.add(n.id);
  if (!(NODE_TYPES as readonly string[]).includes(n.type)) problems.push(`${at}.type: must be one of ${NODE_TYPES.join(', ')}`);
  if (n.as !== undefined && (typeof n.as !== 'string' || !TAG.test(n.as) || n.as === 'script')) problems.push(`${at}.as: must be an HTML tag name`);
  for (const key of ['class', 'text', 'src', 'alt', 'placeholder', 'href', 'html'] as const) {
    if (n[key] !== undefined && typeof n[key] !== 'string') problems.push(`${at}.${key}: must be text`);
  }
  if (n.on?.click) {
    const a = n.on.click as Record<string, unknown>;
    if (!(typeof a['go'] === 'string' || typeof a['toggle'] === 'string' || a['back'] === true)) problems.push(`${at}.on.click: must be {go: page}, {toggle: node} or {back: true}`);
  }
  if (n.children !== undefined) {
    if (!Array.isArray(n.children)) problems.push(`${at}.children: must be a list`);
    else n.children.forEach((child, i) => problems.push(...nodeProblems(child, `${at}.children[${i}]`, seen)));
  }
  return problems;
};

/** What is wrong with a prototype, empty when nothing is. Ids are unique across pages and nodes. */
export const prototypeProblems = (value: unknown): string[] => {
  const p = value as Prototype;
  if (!p || typeof p !== 'object') return ['the prototype must be a mapping'];
  const problems: string[] = [];
  if (typeof p.id !== 'string' || !ID.test(p.id)) problems.push('id: must be a lowercase id');
  if (typeof p.title !== 'string' || !p.title.trim()) problems.push('title: must be text');
  if (!Number.isInteger(p.version) || p.version < 0) problems.push('version: must be a whole number');
  if (!Array.isArray(p.pages) || !p.pages.length) return [...problems, 'pages: must list at least one page'];
  const seen = new Set<string>();
  p.pages.forEach((page, i) => {
    const at = `pages[${i}]`;
    if (typeof page?.id !== 'string' || !ID.test(page.id)) problems.push(`${at}.id: must be a lowercase id`);
    else if (seen.has(page.id)) problems.push(`${at}.id: "${page.id}" is used twice`);
    else seen.add(page.id);
    if (typeof page?.title !== 'string' || !page.title.trim()) problems.push(`${at}.title: must be text`);
    if (!Array.isArray(page?.children)) problems.push(`${at}.children: must be a list`);
    else page.children.forEach((child, j) => problems.push(...nodeProblems(child, `${at}.children[${j}]`, seen)));
  });
  // Every link and toggle must land somewhere that exists.
  const pages = new Set(p.pages.map(page => page.id));
  const walk = (nodes: Node[] | undefined): void => {
    for (const n of nodes ?? []) {
      const a = n.on?.click as Record<string, unknown> | undefined;
      if (a && typeof a['go'] === 'string' && !pages.has(a['go'])) problems.push(`${n.id}.on.click.go: no page "${a['go']}"`);
      if (a && typeof a['toggle'] === 'string' && !seen.has(a['toggle'])) problems.push(`${n.id}.on.click.toggle: no node "${a['toggle']}"`);
      walk(n.children);
    }
  };
  for (const page of p.pages) walk(page.children);
  return problems;
};
