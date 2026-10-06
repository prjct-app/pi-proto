import YAML from 'yaml';
import { listPrototypes, readPrototype } from '../spec/store.ts';
import type { Node } from '../spec/schema.ts';
import type { TargetContext } from '../session-bridge.ts';
import type { ProjectHub, Viewing } from './hub.ts';
type Understood = Readonly<{ intent: 'navigate' | 'undo'; confidence: number; page?: Readonly<{ prototype: string; page: string; title: string }> }>;

type Ask = Record<string, unknown>;
export type AskResult = Readonly<{ status: number; body: { ok?: true; handled?: 'navigate' | 'undo'; error?: string } }>;

const viewingOf = (raw: unknown): Viewing | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  return { at: Date.now(), ...Object.fromEntries(['prototype', 'page', 'node', 'guide']
    .filter(k => typeof t[k] === 'string').map(k => [k, t[k]])) };
};

const findNode = (nodes: readonly Node[], id: string): Node | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children ?? [], id);
    if (child) return child;
  }
  return undefined;
};

const normalized = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[«»"'¿?¡!.,]/g, '').replace(/\s+/g, ' ').trim();

/** Only complete, unambiguous commands are local. Never swallow an editing brief. */
const localCommand = async (hub: ProjectHub, text: string, viewing?: Viewing): Promise<Understood | undefined> => {
  const command = normalized(text);
  if (/^(deshaz|deshacer|deshaz el ultimo cambio|deshacer el ultimo cambio|undo)$/.test(command)) return { intent: 'undo', confidence: 1 };
  const name = /^(?:abre|abrir|muestrame|mostrar|ve a|ir a|open) (?:la pagina |pagina )?(.+)$/.exec(command)?.[1];
  if (!name || name.length > 100) return undefined;
  const prototypes = await Promise.all((await listPrototypes(hub.protoDir)).map(id => readPrototype(hub.protoDir, id).catch(() => undefined)));
  const matches = prototypes.flatMap(p => p ? p.pages.filter(pg => [pg.id, pg.title, `${p.title} ${pg.title}`]
    .some(value => normalized(value) === name)).map(pg => ({ prototype: p.id, page: pg.id, title: pg.title })) : []);
  const current = matches.filter(pg => pg.prototype === viewing?.prototype);
  const candidates = current.length ? current : matches;
  return candidates.length === 1 ? { intent: 'navigate', confidence: 1, page: candidates[0]! } : undefined;
};

/** Read the exact selected/inferred element, at its current version, for the agent. */
const contextOf = async (hub: ProjectHub, target: Viewing | undefined): Promise<TargetContext | undefined> => {
  if (!target?.prototype || !target.node) return undefined;
  const p = await readPrototype(hub.protoDir, target.prototype).catch(() => undefined);
  if (!p) return undefined;
  const page = p.pages.find(pg => pg.id === target.page || (!target.page && !!findNode(pg.children, target.node!)));
  if (!page) return undefined;
  const node = page.id === target.node ? page : findNode(page.children, target.node);
  if (!node) return undefined;
  const yaml = YAML.stringify(node, { lineWidth: 0, aliasDuplicateObjects: false });
  // Large containers are better read with proto_read than cut off mid-YAML.
  if (yaml.length > 12_000) return undefined;
  return { prototype: p.id, page: page.id, version: p.version, node: target.node, yaml };
};

/** The composer can navigate or undo locally; everything else remains the person's Pi message. */
export const handleAsk = async (hub: ProjectHub, body: Ask): Promise<AskResult> => {
  const text = typeof body['text'] === 'string' ? body['text'] : '';
  const images = Array.isArray(body['images']) ? body['images'] : [];
  if (body['artifact'] !== undefined && !['tokens', 'guide', 'prototype'].includes(String(body['artifact']))) return { status: 400, body: { error: 'Unknown requested deliverable.' } };
  if (!text.trim() && !images.length) return { status: 400, body: { error: 'Escribe un mensaje o adjunta una imagen.' } };
  // Each tab sends its own snapshot. The last tab to report viewing must not
  // redirect a command typed in another tab.
  const viewing = Object.hasOwn(body, 'target') ? viewingOf(body['target']) : hub.viewing;
  const direct = images.length ? undefined : await localCommand(hub, text, viewing);
  const viewedVersion = direct?.intent === 'undo' && viewing?.prototype
    ? await readPrototype(hub.protoDir, viewing.prototype).then(p => p.version, () => undefined) : undefined;
  const understood = direct;
  const announce = (): void => hub.publish('ask', { text, images: images.length });
  const reply = (message: string): void => hub.publish('reply', { text: message, at: Date.now() });
  if (understood?.intent === 'navigate' && understood.page) {
    announce();
    hub.publish('navigate', understood.page);
    reply(`Abierta «${understood.page.title}».`);
    return { status: 200, body: { ok: true, handled: 'navigate' } };
  }
  if (understood?.intent === 'undo'
    && hub.sessionSummary()?.agent.state !== 'working') {
    const prototype = understood.page?.prototype ?? viewing?.prototype;
    if (prototype) {
      try {
        // An unqualified "undo" refers to what was visible when submitted.
        // A change during classification must not silently become its target.
        if (prototype !== viewing?.prototype || viewedVersion === undefined) throw new Error('undo needs the currently viewed prototype');
        const undone = await hub.undo(prototype, 'person', viewedVersion);
        announce();
        reply(undone ? 'Deshecho el último cambio.' : 'No hay cambios que deshacer.');
        return { status: 200, body: { ok: true, handled: 'undo' } };
      } catch (error) {
        if (error instanceof Error && error.message.includes('saved')) return { status: 422, body: { error: error.message } };
        /* A changed or invalid target is left for the agent to resolve. */
      }
    }
  }
  const target = viewing;
  const context = await contextOf(hub, target).catch(() => undefined);
  if (!hub.toSession('ask', { ...body, text, viewing, target, context, understood })) {
    return { status: 409, body: { error: 'Ninguna sesión de Pi trabaja en este proyecto. Abre Pi en la carpeta del proyecto.' } };
  }
  announce();
  return { status: 202, body: { ok: true } };
};
