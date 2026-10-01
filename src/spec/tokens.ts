import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

/**
 * The design tokens, in guide/tokens.yaml: the one place a color, a font or a
 * radius is decided. They become Tailwind theme variables, so a prototype says
 * `bg-brand` or `rounded-card` and every prototype stays consistent.
 */

export type Tokens = {
  colors?: Record<string, string>;
  fonts?: Record<string, string>;
  radius?: Record<string, string>;
  spacing?: Record<string, string>;
  text?: Record<string, string>;
  /** Named Tailwind utilities shared by every prototype; states are class variants. */
  components?: Record<string, string | Component>;
};

export type Component = { class: string; as?: string; text?: string; description?: string };

export const TOKENS_FILE = 'tokens.yaml';

export const STARTER_TOKENS = `# Design tokens: every prototype uses them as Tailwind classes.
# colors.brand → bg-brand, text-brand, border-brand · fonts.sans → font-sans · radius.card → rounded-card
colors:
  brand: "#4f46e5"
  ink: "#18181b"
  muted: "#71717a"
  surface: "#ffffff"
fonts:
  sans: "ui-sans-serif, system-ui, -apple-system, sans-serif"
radius:
  card: "12px"
components:
  btn-primary:
    as: button
    text: Continuar
    description: Acción principal; una por sección.
    class: "inline-flex items-center justify-center gap-2 bg-brand text-surface rounded-card px-5 py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
  field-control:
    as: input
    text: Escribe aquí
    description: Campo de texto; siempre con etiqueta visible.
    class: "w-full rounded-card border border-muted bg-surface px-4 py-3 text-ink focus-visible:outline-2 focus-visible:outline-brand"
`;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const VALUE = /^[^;{}<>]{1,120}$/;
const CLASSES = /^[^;{}<>@]{1,2000}$/;
const DEMO_TAGS = new Set(['div', 'span', 'p', 'h1', 'h2', 'button', 'a', 'input', 'textarea']);
const mapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export const tokensProblems = (value: unknown): string[] => {
  if (!mapping(value)) return ['tokens must be a mapping'];
  const problems: string[] = [];
  for (const group of Object.keys(value)) if (!['colors', 'fonts', 'radius', 'spacing', 'text', 'components'].includes(group)) problems.push(`${group}: unsupported token group (use colors, fonts, radius, spacing, text or components)`);
  for (const group of ['colors', 'fonts', 'radius', 'spacing', 'text']) {
    const values = value[group];
    if (values === undefined) continue;
    if (!mapping(values)) { problems.push(`${group}: must be a mapping`); continue; }
    for (const [name, entry] of Object.entries(values)) {
      if (!NAME.test(name) || typeof entry !== 'string' || !VALUE.test(entry)) problems.push(`${group}.${name}: invalid token name or CSS value`);
    }
  }
  if (value['components'] !== undefined) {
    if (!mapping(value['components'])) problems.push('components: must be a mapping');
    else for (const [name, raw] of Object.entries(value['components'])) {
      const c = typeof raw === 'string' ? { class: raw } : raw;
      if (!NAME.test(name) || !mapping(c) || typeof c['class'] !== 'string' || !CLASSES.test(c['class'].trim())) {
        problems.push(`components.${name}: needs a valid name and Tailwind class string`); continue;
      }
      if (c['as'] !== undefined && (typeof c['as'] !== 'string' || !DEMO_TAGS.has(c['as']))) problems.push(`components.${name}.as: unsupported example tag`);
      for (const key of ['text', 'description']) if (c[key] !== undefined && typeof c[key] !== 'string') problems.push(`components.${name}.${key}: must be text`);
    }
  }
  return problems;
};

export const readTokens = async (protoDir: string): Promise<Tokens> => {
  const text = await readFile(join(protoDir, 'guide', TOKENS_FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const value: unknown = (() => {
    try { return YAML.parse(text) ?? {}; }
    catch (error) { throw new Error(`guide/${TOKENS_FILE}: ${error instanceof Error ? error.message : String(error)}. Quote descriptions containing a colon.`); }
  })();
  const problems = tokensProblems(value);
  if (problems.length) throw new Error(`guide/${TOKENS_FILE}: ${problems.join('; ')}`);
  return value as Tokens;
};

export const tokenEntries = (group: Record<string, string> | undefined): Array<[string, string]> =>
  Object.entries(group ?? {}).filter(([name, value]) => NAME.test(name) && typeof value === 'string' && VALUE.test(value));

const entries = tokenEntries;
const esc = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const componentEntries = (tokens: Tokens): Array<[string, Component]> =>
  Object.entries(tokens.components ?? {}).map(([name, raw]) => [name, typeof raw === 'string' ? { class: raw } : raw] as [string, Component])
    .filter(([name, c]) => NAME.test(name) && typeof c?.class === 'string' && CLASSES.test(c.class.trim()));

/** One named class per pattern; updating it changes all its uses through CSS alone. */
export const componentsCss = (tokens: Tokens): string => componentEntries(tokens)
  .map(([name, c]) => `@utility ${name} {\n  @apply ${c.class.trim().replace(/\s+/g, ' ')};\n}\n`).join('\n');

export const componentsMarkdown = (tokens: Tokens): string => {
  const components = componentEntries(tokens);
  if (!components.length) return 'Todavía no hay patrones con nombre. Defínelos en `guide/tokens.yaml`, bajo `components`.';
  return ['Se usan por su nombre como clase; los estados (hover, foco, disabled) se definen con variantes de Tailwind.', '',
    ...components.flatMap(([name, c]) => {
      const tag = c.as && DEMO_TAGS.has(c.as) ? c.as : 'div';
      const label = esc(c.text ?? name);
      const preview = tag === 'input' ? `<label>${esc(c.description ?? name)}<input class="${name}" placeholder="${label}" /></label>`
        : tag === 'textarea' ? `<label>${esc(c.description ?? name)}<textarea class="${name}" placeholder="${label}"></textarea></label>`
        : `<${tag} class="${name}"${tag === 'button' ? ' type="button"' : tag === 'a' ? ' href="#"' : ''}>${label}</${tag}>`;
      return [`## ${name}`, '', c.description ? `<p>${esc(c.description)}</p>` : '', `<div data-proto-example>${preview}</div>`, '',
        `<p><code>${esc(c.class)}</code></p>`, ''];
    })].join('\n').trim();
};

/** `@theme { --color-brand: …; }` for Tailwind v4. */
export const themeCss = (tokens: Tokens): string => {
  const lines = [
    ...entries(tokens.colors).map(([n, v]) => `  --color-${n}: ${v};`),
    ...entries(tokens.fonts).map(([n, v]) => `  --font-${n}: ${v};`),
    ...entries(tokens.radius).map(([n, v]) => `  --radius-${n}: ${v};`),
    ...entries(tokens.spacing).map(([n, v]) => `  --spacing-${n}: ${v};`),
    ...entries(tokens.text).map(([n, v]) => `  --text-${n}: ${v};`),
  ];
  return lines.length ? `@theme {\n${lines.join('\n')}\n}\n` : '';
};

/** The tokens page of the guide, generated: swatches, fonts and radii drawn with their own classes. */
export const tokensMarkdown = (tokens: Tokens): string => {
  const out: string[] = [];
  const colors = entries(tokens.colors);
  if (colors.length) {
    out.push('## Color', '', '<div class="flex flex-wrap gap-4">');
    for (const [name, value] of colors) out.push(`<div class="w-32"><div class="h-16 rounded-lg ring-1 ring-black/10 bg-${name}"></div><p class="mt-2 text-sm font-semibold">${name}</p><p class="text-xs text-zinc-500">${esc(value)} · <code>bg-${name}</code></p></div>`);
    out.push('</div>', '');
  }
  const fonts = entries(tokens.fonts);
  if (fonts.length) {
    out.push('## Tipografía', '');
    for (const [name, value] of fonts) out.push(`<p class="font-${name} text-2xl">Aa · ${name}</p><p class="text-xs text-zinc-500"><code>font-${name}</code> · ${esc(value)}</p>`, '');
  }
  const radius = entries(tokens.radius);
  for (const [name, value] of entries(tokens.text)) out.push(`<p class="text-${name}">Aa · ${name}</p><p><code>text-${name}</code> · ${esc(value)}</p>`, '');
  if (radius.length) {
    out.push('## Radios', '', '<div class="flex flex-wrap gap-4">');
    for (const [name, value] of radius) out.push(`<div class="w-32"><div class="h-16 bg-zinc-200 rounded-${name}"></div><p class="mt-2 text-xs text-zinc-500"><code>rounded-${name}</code> · ${esc(value)}</p></div>`);
    out.push('</div>', '');
  }
  const spacing = entries(tokens.spacing);
  if (spacing.length) {
    out.push('## Espaciado', '');
    for (const [name, value] of spacing) out.push(`<p><code>p-${name}</code> / <code>gap-${name}</code> · ${esc(value)}</p>`, '');
  }
  if (!out.length) out.push(`Todavía no hay tokens. Defínelos en \`guide/${TOKENS_FILE}\`.`);
  return out.join('\n').trim();
};
