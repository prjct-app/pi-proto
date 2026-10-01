import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSitemap, type SitemapPrototype } from './spec/sitemap.ts';
import { readTokens, tokensMarkdown, componentsMarkdown, componentEntries, TOKENS_FILE, type Tokens } from './spec/tokens.ts';
import { listPrototypes, readPrototype } from './spec/store.ts';
import { auditPrototype, type Finding } from './spec/audit.ts';
import { readGuides } from './story.ts';
import { DESIGN_SLUG } from './design-guide.ts';

/**
 * The documentation that writes itself, in the design guide: the tokens drawn
 * with their own classes, and the sitemap (which prototype each page belongs
 * to, its flows, and every link and interaction). Only the part between the
 * markers is regenerated; whatever is written around it stays.
 */

export const TOKENS_SLUG = '10-tokens';
export const SITEMAP_SLUG = '90-sitemap';
export const COMPONENTS_SLUG = '20-components';
export const HANDOFF_SLUG = '95-handoff';
const START = '<!-- proto:auto:start -->';
const END = '<!-- proto:auto:end -->';

const pageTitle = (proto: SitemapPrototype, id: string | undefined): string => proto.pages.find(p => p.id === id)?.title ?? (id ? `#${id}` : '');
const cell = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

/** A bounded index, not a second copy of the design specification and tokens. */
export const handoffMarkdown = (prototypes: readonly SitemapPrototype[], tokens: Tokens,
  guides: readonly { title: string; slug: string; markdown: string }[], findings: readonly Finding[], problems: readonly string[]): string => {
  const lines = ['## Línea de diseño', ''];
  const design = guides.find(g => g.slug === DESIGN_SLUG);
  lines.push(design ? '[Especificación para agentes](00-design) · `guide/00-design.md` (alcance, referencias y decisiones).'
    : 'Pendiente: especificación breve en `guide/00-design.md`. Este índice no la sustituye.', '');
  if (!design && guides.length) lines.push(...guides.slice(0, 4).map(g => `- [${cell(g.title).slice(0, 60)}](${g.slug})`), '');
  const components = componentEntries(tokens).map(([name]) => name);
  lines.push('## Fuentes únicas', '', `\`guide/tokens.yaml\`: valores opcionales. [Tokens](10-tokens)${components.length ? ' · [Patrones existentes](20-components)' : ''} · [Sitemap completo](90-sitemap). La guía no depende de un framework ni exige un catálogo de componentes.`, '');
  if (components.length) lines.push(`Patrones (${components.length}): ${components.slice(0, 8).map(name => `\`${name}\``).join(', ')}${components.length > 8 ? '; resto en tokens.yaml' : ''}.`, '');
  lines.push('## Navegación para desarrollar', '', 'Enlaces reales; agrupar páginas en un flujo no crea navegación.', '');
  const budget = { words: lines.join(' ').split(/\s+/).length, omitted: 0 };
  const add = (line: string): void => {
    const words = line.split(/\s+/).length;
    if (budget.words + words > 330) { budget.omitted += 1; return; }
    budget.words += words; lines.push(line);
  };
  for (const p of prototypes) {
    add(`### ${cell(p.title).slice(0, 60)} · \`${p.id}\` v${p.version} · ${p.status}`);
    add('| Página | Flujo | Entradas | Salidas |'); add('| --- | --- | --- | --- |');
    for (const pg of p.pages) {
      const incoming = [...new Set(p.interactions.filter(i => i.kind === 'go' && i.target === pg.id).map(i => pageTitle(p, i.page)))];
      const exits = p.interactions.filter(i => i.page === pg.id).map(i => `${i.label}: ${i.kind === 'go' ? pageTitle(p, i.target) : i.kind === 'toggle' ? `mostrar/ocultar ${i.target}` : 'volver a la página previa'}`);
      const clip = (values: string[]): string => `${values.slice(0, 2).map(v => cell(v).slice(0, 64)).join('; ')}${values.length > 2 ? `; +${values.length - 2}` : ''}`;
      add(`| ${cell(pg.title).slice(0, 40)} (\`#${pg.id}\`) | ${cell(pg.flow ?? '—').slice(0, 30)} | ${clip([...(p.pages[0]?.id === pg.id ? ['Entrada inicial'] : []), ...incoming]) || 'Sin enlace de entrada'} | ${clip(exits) || 'Sin salida definida'} |`);
    }
  }
  if (budget.omitted) lines.push(`Vista parcial (${budget.omitted} filas omitidas): consultar [Sitemap completo](90-sitemap).`);
  lines.push('', '## Comprobaciones y pendientes', '', `${findings.length} hallazgos · ${problems.length} errores. Detalle: \`guide/96-checks.json\`. No certifica calidad visual ni accesibilidad completa.`);
  for (const f of findings.slice(0, 3)) lines.push(`- \`${f.prototype}/${f.page ?? ''}/${f.node ?? ''}\` · ${cell(f.message).slice(0, 100)}`);
  return lines.join('\n').trim();
};

export const sitemapMarkdown = (prototypes: readonly SitemapPrototype[], problems: readonly string[] = []): string => {
  const lines: string[] = [];
  for (const problem of problems) lines.push(`> ⚠ ${problem}`, '');
  if (!prototypes.length) return [...lines, 'Todavía no hay prototipos.'].join('\n');
  lines.push(`${prototypes.length} prototipo${prototypes.length === 1 ? '' : 's'} · ${prototypes.reduce((n, p) => n + p.pages.length, 0)} páginas.`, '');
  for (const proto of prototypes) {
    lines.push(`## ${proto.title}${proto.group ? ` · ${proto.group}` : ''}`, '', `\`${proto.file}\` · v${proto.version} · ${proto.status}`, '');
    if (proto.description) lines.push(proto.description, '');
    for (const flow of proto.flows) {
      if (flow.name) lines.push(`### ${flow.name}`, '');
      for (const pageId of flow.pages) {
        const page = proto.pages.find(p => p.id === pageId)!;
        const next = [...new Set(proto.interactions.filter(i => i.page === pageId && i.kind === 'go').map(i => pageTitle(proto, i.target)))];
        lines.push(`- **${page.title}** \`#${page.id}\`${next.length ? ` → ${next.join(', ')}` : ''}`);
      }
      lines.push('');
    }
    if (proto.interactions.length) {
      lines.push('### Interacciones', '', '| Página | Elemento | Acción |', '| --- | --- | --- |');
      for (const i of proto.interactions) {
        const action = i.kind === 'go' ? `ir a **${pageTitle(proto, i.target)}**` : i.kind === 'toggle' ? `mostrar/ocultar \`${i.target}\`` : 'volver';
        lines.push(`| ${pageTitle(proto, i.page)} | ${i.label.replace(/\|/g, '\\|')} \`${i.node}\` | ${action} |`);
      }
      lines.push('');
    }
    const reached = new Set(proto.interactions.filter(i => i.kind === 'go').map(i => i.target));
    const orphans = proto.pages.slice(1).filter(p => !reached.has(p.id));
    if (orphans.length) lines.push(`> Ningún enlace lleva a: ${orphans.map(p => p.title).join(', ')}.`, '');
  }
  return lines.join('\n').trim();
};

/** Rewrite the generated part of a guide page, keeping everything written around it. */
export const mergeGenerated = (existing: string | undefined, title: string, order: number, generated: string): string => {
  const block = `${START}\n${generated}\n${END}`;
  if (existing?.includes(START) && existing.includes(END)) {
    return existing.slice(0, existing.indexOf(START)) + block + existing.slice(existing.indexOf(END) + END.length);
  }
  const notes = existing?.trim() ? `\n\n${existing.trim()}\n` : '\n\n## Notas\n\nLo que escribas aquí no se regenera.\n';
  return `---\ntitle: ${title}\norder: ${order}\n---\n\n# ${title}\n\n${block}${notes}`;
};

const writeGenerated = async (protoDir: string, slug: string, title: string, order: number, generated: string): Promise<boolean> => {
  const file = join(protoDir, 'guide', `${slug}.md`);
  const existing = await readFile(file, 'utf8').catch(() => undefined);
  const next = mergeGenerated(existing, title, order, generated);
  if (next === existing) return false;
  await mkdir(join(protoDir, 'guide'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, next, 'utf8');
  await rename(tmp, file);
  return true;
};

/** Regenerate the documentation pages; true when any of them changed. */
export const writeDocs = async (protoDir: string): Promise<boolean> => {
  const { prototypes, problems } = await readSitemap(protoDir);
  const design = await readTokens(protoDir);
  const authored = await Promise.all((await readGuides(protoDir))
    .filter(g => ![TOKENS_SLUG, SITEMAP_SLUG, COMPONENTS_SLUG, HANDOFF_SLUG].includes(g.slug))
    .map(async g => ({ ...g, markdown: await readFile(g.file, 'utf8') })));
  const findings = (await Promise.all((await listPrototypes(protoDir)).map(async id => {
    const p = await readPrototype(protoDir, id).catch(() => undefined);
    return p ? auditPrototype(p, design) : [];
  }))).flat();
  const sitemap = await writeGenerated(protoDir, SITEMAP_SLUG, 'Sitemap', 90, sitemapMarkdown(prototypes, problems));
  const tokens = await writeGenerated(protoDir, TOKENS_SLUG, 'Tokens', 10,
    `${tokensMarkdown(design)}\n\n<p class="text-xs text-zinc-500">Se editan en <code>guide/${TOKENS_FILE}</code>.</p>`);
  const components = componentEntries(design).length > 0
    ? await writeGenerated(protoDir, COMPONENTS_SLUG, 'Patrones existentes', 20, componentsMarkdown(design)) : false;
  const handoff = await writeGenerated(protoDir, HANDOFF_SLUG, 'Entrega', 95, handoffMarkdown(prototypes, design, authored, findings, problems));
  const report = join(protoDir, 'guide', '96-checks.json');
  const checks = `${JSON.stringify({ problems, findings }, null, 2)}\n`;
  const changed = await readFile(report, 'utf8').catch(() => '') !== checks;
  if (changed) await writeFile(report, checks, 'utf8');
  return sitemap || tokens || components || handoff || changed;
};
