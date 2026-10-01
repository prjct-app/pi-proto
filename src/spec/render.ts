import type { Node, Page, Prototype } from './schema.ts';

/**
 * YAML → HTML. Every element carries `data-node` with its id, so one node can
 * be redrawn alone in the open page; every page is a `[data-screen]` section
 * the runtime shows one at a time; clicks become data-goto / data-toggle /
 * data-back, which the runtime handles.
 */

const DEFAULT_TAG: Record<Node['type'], string> = {
  box: 'div', stack: 'div', row: 'div', grid: 'div', text: 'p', image: 'img', button: 'button',
  input: 'input', textarea: 'textarea', link: 'a', icon: 'span', divider: 'hr', html: 'div',
};

/** Layout the type means, before the node's own classes. */
const BASE_CLASS: Partial<Record<Node['type'], string>> = {
  stack: 'flex flex-col', row: 'flex flex-row items-center', grid: 'grid',
};

const VOID = new Set(['img', 'input', 'hr', 'br']);

const esc = (text: string): string => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const attr = (name: string, value: string | undefined): string => (value === undefined ? '' : ` ${name}="${esc(value)}"`);

/** Attributes a node may not set through `attrs`: they are the renderer's. */
const RESERVED = /^(on|data-node$|data-screen$|data-goto$|data-toggle$|data-back$|id$|class$|style$)/i;

export const renderNode = (node: Node): string => {
  const tag = node.as ?? DEFAULT_TAG[node.type];
  const classes = [BASE_CLASS[node.type], node.class].filter(Boolean).join(' ');
  const click = node.on?.click as { go?: string; toggle?: string; back?: true } | undefined;
  const attrs = [
    attr('id', node.id),
    attr('data-node', node.id),
    attr('class', classes || undefined),
    node.type === 'image' ? attr('src', node.src ?? '') + attr('alt', node.alt ?? '') : '',
    node.type === 'input' || node.type === 'textarea' ? attr('placeholder', node.placeholder) : '',
    node.type === 'link' ? attr('href', click?.go ? `#${click.go}` : node.href ?? '#') : '',
    node.type === 'button' ? ' type="button"' : '',
    attr('data-goto', click?.go),
    attr('data-toggle', click?.toggle),
    click?.back ? ' data-back' : '',
    node.hidden ? ' hidden' : '',
    ...Object.entries(node.attrs ?? {}).filter(([name]) => !RESERVED.test(name) && /^[a-z][a-z0-9-:]*$/i.test(name)).map(([name, value]) => attr(name, String(value))),
  ].join('');
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  const inner = node.type === 'html'
    ? node.html ?? ''
    : `${node.text !== undefined ? esc(node.text) : ''}${(node.children ?? []).map(renderNode).join('')}`;
  return `<${tag}${attrs}>${inner}</${tag}>`;
};

export const renderPage = (page: Page): string =>
  `<section id="${esc(page.id)}" data-node="${esc(page.id)}" data-screen="${esc(page.title)}"${attr('data-flow', page.flow)}${attr('class', page.class)}>${page.children.map(renderNode).join('')}</section>`;

/** The whole prototype as one HTML document; `assets` is the relative path to main.css and the runtime. */
export const renderPrototype = (prototype: Prototype, assets = ''): string => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="proto-channel" content="story">
<meta name="proto-version" content="${prototype.version}">
<title>${esc(prototype.title)}</title>${prototype.description ? `\n<meta name="description" content="${esc(prototype.description)}">` : ''}
<link rel="stylesheet" href="${assets}main.css">
</head>
<body>
${prototype.pages.map(renderPage).join('\n')}
<script src="${assets}gsap.js"></script>
<script src="${assets}proto.js"></script>
</body>
</html>
`;

/** Every class a prototype uses, to know when a change needs new CSS. */
export const classesOf = (prototype: Prototype): Set<string> => {
  const classes = new Set<string>();
  const add = (value: string | undefined): void => { for (const c of (value ?? '').split(/\s+/)) if (c) classes.add(c); };
  const walk = (nodes: Node[] | undefined): void => { for (const n of nodes ?? []) { add(n.class); add(BASE_CLASS[n.type]); walk(n.children); } };
  for (const page of prototype.pages) { add(page.class); walk(page.children); }
  return classes;
};

/** A node or page by id, for redrawing it alone. */
export const renderById = (prototype: Prototype, id: string): string | undefined => {
  const page = prototype.pages.find(p => p.id === id);
  if (page) return renderPage(page);
  const find = (nodes: Node[] | undefined): Node | undefined => {
    for (const n of nodes ?? []) { if (n.id === id) return n; const found = find(n.children); if (found) return found; }
    return undefined;
  };
  for (const p of prototype.pages) { const node = find(p.children); if (node) return renderNode(node); }
  return undefined;
};
