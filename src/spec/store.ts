import { mkdir, readdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { prototypeProblems, type Fields, type HistoryEntry, type Node, type Op, type Page, type Prototype } from './schema.ts';

/**
 * Prototypes as versioned YAML. Every change is a list of operations on ids;
 * applying it bumps `version` and appends a history entry, in the same file,
 * with the operations that undo it. Going back to an earlier version applies
 * those, as a new version, so nothing is ever lost.
 */

/** History kept in the file; older entries are dropped, the version number keeps counting. */
const HISTORY_LIMIT = 300;

export const prototypesDir = (protoDir: string): string => join(protoDir, 'prototypes');
export const fileOf = (protoDir: string, id: string): string => join(prototypesDir(protoDir), `${id}.yaml`);

/** "Pago con tarjeta" → "pago-con-tarjeta". */
export const slug = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';

const clone = <T>(value: T): T => structuredClone(value);

export const listPrototypes = async (protoDir: string): Promise<string[]> =>
  (await readdir(prototypesDir(protoDir)).catch(() => [] as string[])).filter(name => name.endsWith('.yaml')).map(name => name.slice(0, -5)).sort();

const parsed = new Map<string, { signature: string; prototype: Prototype }>();
export const readPrototype = async (protoDir: string, id: string): Promise<Prototype> => {
  const file = fileOf(protoDir, id);
  const info = await stat(file).catch(() => undefined);
  const signature = info ? `${info.ino}/${info.size}/${info.mtimeMs}/${info.ctimeMs}` : '';
  const cached = parsed.get(file);
  // Return independent values, just as parsing did; a caller cannot mutate
  // another reader's state. External edits invalidate the filesystem signature.
  if (info && cached?.signature === signature) return clone(cached.prototype);
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) throw new Error(`no prototype "${id}".`);
  const value = YAML.parse(text) as Prototype;
  const problems = prototypeProblems(value);
  if (problems.length) throw new Error(`prototypes/${id}.yaml is not valid: ${problems.slice(0, 5).join('; ')}`);
  if (parsed.size >= 128) parsed.delete(parsed.keys().next().value!);
  parsed.set(file, { signature, prototype: clone(value) });
  return value;
};

export const toYaml = (prototype: Prototype, options: { history?: boolean } = {}): string => {
  const { history, ...rest } = prototype;
  const value = options.history === false || !history?.length ? rest : { ...rest, history };
  return YAML.stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
};

const writeAtomic = async (file: string, text: string): Promise<void> => {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
};

// ---- the tree ----

type Parent = { children?: Node[] };
type Located = { node: Node; parent: Parent; index: number; page: Page };

const locate = (prototype: Prototype, id: string): Located | undefined => {
  for (const page of prototype.pages) {
    const walk = (parent: Parent): Located | undefined => {
      for (const [index, node] of (parent.children ?? []).entries()) {
        if (node.id === id) return { node, parent, index, page };
        const found = walk(node);
        if (found) return found;
      }
      return undefined;
    };
    const found = walk(page);
    if (found) return found;
  }
  return undefined;
};

/** The child list of a page or node, and the page it is on. */
const container = (prototype: Prototype, id: string): { list: Node[]; page: Page; isPage: boolean } => {
  const page = prototype.pages.find(p => p.id === id);
  if (page) return { list: page.children, page, isPage: true };
  const found = locate(prototype, id);
  if (!found) throw new Error(`no page or node "${id}".`);
  found.node.children ??= [];
  return { list: found.node.children, page: found.page, isPage: false };
};

const descendants = (node: Node): Set<string> => {
  const ids = new Set<string>();
  const walk = (n: Node): void => { ids.add(n.id); for (const child of n.children ?? []) walk(child); };
  walk(node);
  return ids;
};

export const allIds = (prototype: Prototype): Set<string> => {
  const ids = new Set(prototype.pages.map(p => p.id));
  const walk = (nodes: Node[] | undefined): void => { for (const n of nodes ?? []) { ids.add(n.id); walk(n.children); } };
  for (const page of prototype.pages) walk(page.children);
  return ids;
};

/** Give every node without an id (or with a taken one) a readable, unique id. */
const withIds = (node: Node, taken: Set<string>): Node => {
  const base = node.id && !taken.has(node.id) ? node.id : slug(`${node.type ?? 'box'}-${node.text ?? node.alt ?? node.placeholder ?? ''}`);
  const id = uniqueId(base, taken);
  taken.add(id);
  return { ...node, id, ...(node.children ? { children: node.children.map(child => withIds(child, taken)) } : {}) };
};

export const uniqueId = (base: string, taken: ReadonlySet<string>): string =>
  Array.from({ length: taken.size + 2 }, (_, i) => i ? `${base}-${i + 1}` : base).find(id => !taken.has(id))!;

/** A copy of a page under a new id, with fresh node ids, for "duplicate". */
export const copyPage = (prototype: Prototype, from: string, id: string, title: string, flow?: string): Page => {
  const source = prototype.pages.find(p => p.id === from);
  if (!source) throw new Error(`no page "${from}" to copy.`);
  const taken = allIds(prototype);
  taken.add(id);
  const renamed = new Map<string, string>([[from, id]]);
  const renumber = (node: Node): Node => {
    const freshId = uniqueId(slug(`${node.type}-${node.text ?? node.alt ?? node.placeholder ?? node.id}`), taken);
    taken.add(freshId);
    renamed.set(node.id, freshId);
    return { ...clone(node), id: freshId, ...(node.children ? { children: node.children.map(renumber) } : {}) };
  };
  const children = source.children.map(renumber);
  const relink = (node: Node): Node => {
    const action = node.on?.click;
    const click = action && ('toggle' in action ? { toggle: renamed.get(action.toggle) ?? action.toggle }
      : 'go' in action ? { go: renamed.get(action.go) ?? action.go } : action);
    const href = node.href === `#${from}` ? `#${id}` : node.href;
    return { ...node, ...(href !== undefined ? { href } : {}), ...(click ? { on: { ...node.on, click } } : {}),
      ...(node.children ? { children: node.children.map(relink) } : {}) };
  };
  return { ...clone(source), id, title, ...(flow !== undefined ? { flow } : {}), children: children.map(relink) };
};

// ---- operations ----

/** What an operation touched, so the storybook redraws only that. */
export type Touched = { nodes: Set<string>; pages: Set<string>; structure: boolean };

const setFields = (target: Record<string, unknown>, fields: Fields): Fields => {
  const before: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'id' || key === 'children') continue;
    before[key] = target[key] === undefined ? null : clone(target[key]);
    if (value === null || value === undefined) delete target[key];
    else target[key] = clone(value);
  }
  return before as Fields;
};

/** Apply one operation in place; returns the operation that undoes it. */
const applyOne = (prototype: Prototype, op: Op, touched: Touched): Op => {
  switch (op.op) {
    case 'set': {
      const page = prototype.pages.find(p => p.id === op.id);
      if (page) {
        touched.pages.add(page.id);
        if (op.fields.title !== undefined || op.fields.flow !== undefined) touched.structure = true;
        return { op: 'set', id: op.id, fields: setFields(page as unknown as Record<string, unknown>, op.fields) };
      }
      const found = locate(prototype, op.id);
      if (!found) throw new Error(`no node "${op.id}".`);
      touched.nodes.add(op.id);
      return { op: 'set', id: op.id, fields: setFields(found.node as unknown as Record<string, unknown>, op.fields) };
    }
    case 'insert': {
      const parent = container(prototype, op.parent);
      const node = withIds(clone(op.node), allIds(prototype));
      const index = op.index === undefined ? parent.list.length : Math.max(0, Math.min(op.index, parent.list.length));
      parent.list.splice(index, 0, node);
      if (parent.isPage) touched.pages.add(op.parent); else touched.nodes.add(op.parent);
      return { op: 'remove', id: node.id };
    }
    case 'remove': {
      const found = locate(prototype, op.id);
      if (!found) throw new Error(`no node "${op.id}".`);
      found.parent.children!.splice(found.index, 1);
      const onPage = found.parent === found.page;
      const parentId = onPage ? found.page.id : (found.parent as Node).id;
      if (onPage) touched.pages.add(found.page.id); else touched.nodes.add(parentId);
      return { op: 'insert', parent: parentId, index: found.index, node: found.node };
    }
    case 'move': {
      const found = locate(prototype, op.id);
      if (!found) throw new Error(`no node "${op.id}".`);
      if (descendants(found.node).has(op.parent)) throw new Error('a node cannot move inside itself.');
      const from = found.parent === found.page ? found.page.id : (found.parent as Node).id;
      found.parent.children!.splice(found.index, 1);
      const target = container(prototype, op.parent);
      const index = op.index === undefined ? target.list.length : Math.max(0, Math.min(op.index, target.list.length));
      target.list.splice(index, 0, found.node);
      touched.structure = true;
      touched.pages.add(found.page.id);
      touched.pages.add(target.page.id);
      return { op: 'move', id: op.id, parent: from, index: found.index };
    }
    case 'add_page': {
      const taken = allIds(prototype);
      if (taken.has(op.page.id)) throw new Error(`"${op.page.id}" is already used.`);
      taken.add(op.page.id);
      const page: Page = { ...clone(op.page), children: (op.page.children ?? []).map(child => withIds(child, taken)) };
      const index = op.index === undefined ? prototype.pages.length : Math.max(0, Math.min(op.index, prototype.pages.length));
      prototype.pages.splice(index, 0, page);
      touched.structure = true;
      touched.pages.add(page.id);
      return { op: 'remove_page', id: page.id };
    }
    case 'remove_page': {
      const index = prototype.pages.findIndex(p => p.id === op.id);
      if (index < 0) throw new Error(`no page "${op.id}".`);
      if (prototype.pages.length === 1) throw new Error('a prototype keeps at least one page.');
      const [page] = prototype.pages.splice(index, 1);
      touched.structure = true;
      return { op: 'add_page', page: page!, index };
    }
    case 'set_prototype': {
      touched.structure = true;
      return { op: 'set_prototype', fields: setFields(prototype as unknown as Record<string, unknown>, op.fields as Fields) as never };
    }
  }
};

/** One file changes at a time, whoever asks: the storybook, the agent, another session. */
const locks = new Map<string, Promise<unknown>>();
const serially = <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  locks.set(key, next.catch(() => undefined));
  return next;
};

export type Applied = Readonly<{ prototype: Prototype; version: number; touched: Touched }>;

/**
 * Apply a list of operations as one version. Either all of them apply and the
 * result is valid, or the file is left as it was.
 */
const applyLocked = async (protoDir: string, id: string, ops: readonly Op[], meta: { by: string; did: string }): Promise<Applied> => {
    if (!ops.length) throw new Error('nothing to change.');
    const current = await readPrototype(protoDir, id);
    const next = clone(current);
    const touched: Touched = { nodes: new Set(), pages: new Set(), structure: false };
    const undo = ops.map(op => applyOne(next, op, touched)).reverse();
    const problems = prototypeProblems(next);
    if (problems.length) throw new Error(`that change would break the prototype: ${problems.slice(0, 5).join('; ')}`);
    next.version = current.version + 1;
    const entry: HistoryEntry = { v: next.version, at: new Date().toISOString(), by: meta.by, did: meta.did, undo };
    next.history = [...(current.history ?? []), entry].slice(-HISTORY_LIMIT);
    await writeAtomic(fileOf(protoDir, id), toYaml(next));
    return { prototype: next, version: next.version, touched };
};

export const applyOps = (protoDir: string, id: string, ops: readonly Op[], meta: { by: string; did: string }): Promise<Applied> =>
  serially(fileOf(protoDir, id), () => applyLocked(protoDir, id, ops, meta));

/** Go back to `version` by undoing every change after it, as a new version. */
export const revertTo = (protoDir: string, id: string, version: number, by: string): Promise<Applied> => serially(fileOf(protoDir, id), async () => {
  const current = await readPrototype(protoDir, id);
  if (!Number.isInteger(version) || version < 1 || version >= current.version) throw new Error('choose an earlier version, from v1 onwards.');
  const later = (current.history ?? []).filter(entry => entry.v > version).sort((a, b) => b.v - a.v);
  if (!later.length) throw new Error(`v${version} is the current version.`);
  const oldest = current.history?.[0]?.v ?? current.version;
  if (version < oldest - 1) throw new Error(`the history kept goes back to v${oldest - 1}.`);
  return applyLocked(protoDir, id, later.flatMap(entry => entry.undo), { by, did: `volver a la versión ${version}` });
});

/** Read and undo under the same lock: an edit arriving concurrently is never undone by accident. */
export const undoLast = (protoDir: string, id: string, by: string, expectedVersion?: number): Promise<Applied | undefined> => serially(fileOf(protoDir, id), async () => {
  const current = await readPrototype(protoDir, id);
  if (expectedVersion !== undefined && current.version !== expectedVersion) throw new Error('the prototype changed while the undo request was being understood.');
  const last = current.history?.at(-1);
  if (!last || !last.undo.length || last.v !== current.version) return undefined;
  return applyLocked(protoDir, id, last.undo, { by, did: `deshacer: ${last.did}` });
});

export const createPrototype = async (protoDir: string, input: { title: string; group?: string; description?: string; by: string }): Promise<Prototype> => {
  await mkdir(prototypesDir(protoDir), { recursive: true });
  const taken = new Set(await listPrototypes(protoDir));
  const id = uniqueId(slug(input.title), taken);
  const prototype: Prototype = {
    proto: 1,
    id,
    title: input.title,
    ...(input.group ? { group: input.group } : {}),
    ...(input.description ? { description: input.description } : {}),
    status: 'draft',
    version: 1,
    pages: [{ id: 'inicio', title: 'Inicio', class: 'min-h-screen p-8', children: [{ id: 'titulo', type: 'text', as: 'h1', class: 'text-3xl font-bold', text: input.title }] }],
    history: [{ v: 1, at: new Date().toISOString(), by: input.by, did: 'crear el prototipo', undo: [] }],
  };
  await writeAtomic(fileOf(protoDir, id), toYaml(prototype));
  return prototype;
};
