import { parseHTML } from 'linkedom';
import { renderPrototype } from './render.ts';
import type { Prototype } from './schema.ts';
import { componentEntries, type Tokens } from './tokens.ts';

export type Finding = Readonly<{ prototype: string; page?: string; node?: string; code: string; message: string }>;

const COLORS = /^(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)$/;

/** Facts visible in the rendered DOM. This deliberately makes no judgment about visual taste. */
export const auditPrototype = (p: Prototype, tokens: Tokens): Finding[] => {
  const { document } = parseHTML(renderPrototype(p));
  const findings: Finding[] = [];
  const pages = [...document.querySelectorAll('[data-screen]')];
  const reached = new Set<string>();
  const patterns = new Map(componentEntries(tokens));
  const add = (el: Element, code: string, message: string): void => {
    findings.push({ prototype: p.id, page: el.closest('[data-screen]')?.id, node: el.closest('[data-node]')?.getAttribute('data-node') ?? undefined, code, message });
  };
  for (const el of document.querySelectorAll('[data-goto],a[href^="#"],[data-toggle]')) {
    const go = el.getAttribute('data-goto');
    const href = el.getAttribute('href');
    const toggle = el.getAttribute('data-toggle');
    const raw = go ?? (href && href !== '#' ? href.slice(1) : undefined);
    const target = raw ? (() => { try { return decodeURIComponent(raw); } catch { return raw; } })() : undefined;
    if (target) {
      if (pages.some(pg => pg.id === target)) reached.add(target);
      else if (!go && document.getElementById(target)) { /* An ordinary in-page anchor. */ }
      else add(el, 'broken-link', `El enlace apunta a «${target}», que no existe como página${go ? '' : ' o ancla'}.`);
    } else if (el.tagName === 'A' && href === '#' && !toggle && !el.hasAttribute('data-back')) {
      add(el, 'empty-link', 'Enlace sin destino: define su navegación o documenta que aún no está implementada.');
    }
    if (toggle) {
      const destination = document.getElementById(toggle);
      if (!destination) add(el, 'broken-toggle', `La interacción apunta a «${toggle}», que no existe.`);
      else if (destination.closest('[data-screen]') !== el.closest('[data-screen]')) add(el, 'cross-page-toggle', `«${toggle}» está en otra página; este toggle no puede mostrarlo en la página actual.`);
    }
  }
  for (const pg of pages.slice(1)) if (!reached.has(pg.id)) add(pg, 'orphan-page', `Ningún enlace lleva a «${pg.getAttribute('data-screen')}».`);
  const named = (el: Element): boolean => {
    if (el.getAttribute('aria-label')?.trim()) return true;
    const ids = el.getAttribute('aria-labelledby')?.trim().split(/\s+/).filter(Boolean) ?? [];
    return ids.length > 0 && ids.every(id => !!document.getElementById(id)?.textContent?.trim());
  };
  for (const el of document.querySelectorAll('input:not([type="hidden"]),textarea,select')) {
    const associated = el.id && [...document.querySelectorAll('label[for]')].some(label => label.getAttribute('for') === el.id && !!label.textContent?.trim());
    const wrapped = el.closest('label')?.textContent?.trim();
    if (!associated && !wrapped && !named(el)) add(el, 'input-label', 'Campo sin etiqueta o nombre accesible; el placeholder no sustituye una etiqueta.');
    else if (!associated && !wrapped) add(el, 'visible-label', 'Campo con nombre accesible pero sin etiqueta visible.');
  }
  for (const el of document.querySelectorAll('button,a')) {
    if (!el.textContent?.trim() && !named(el) && ![...el.querySelectorAll('img[alt]')].some(img => img.getAttribute('alt')?.trim())) add(el, 'control-name', 'Control sin nombre accesible.');
  }
  for (const el of document.querySelectorAll('img:not([alt])')) add(el, 'image-alt', 'Imagen sin atributo alt; describe su función o marca alt="" si es decorativa.');
  for (const el of document.querySelectorAll('[class]')) {
    const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const expanded = classes.flatMap(c => [c, ...(patterns.get(c)?.class.split(/\s+/) ?? [])]);
    for (const cls of new Set(expanded)) {
      // Only split variant separators outside arbitrary-value brackets.
      const plain = cls.split(/:(?![^\[]*\])/).at(-1) ?? cls;
      const match = /^(?:bg|text|border|ring|outline|fill|stroke|decoration|accent|caret|shadow|from|via|to)-(.+)$/.exec(plain);
      if (!match) continue;
      const color = match[1]!.split('/')[0]!;
      const arbitrary = /^\[.*(?:#|rgb|hsl|oklch|oklab|color:|color\().*\]$/.test(color);
      if ((COLORS.test(color) && !Object.hasOwn(tokens.colors ?? {}, color)) || arbitrary) add(el, 'color-token', `«${cls}» usa un color fuera de guide/tokens.yaml.`);
    }
  }
  for (const el of document.querySelectorAll('[style]')) {
    if (/(?:^|;)\s*(?:color|background(?:-color)?|border-color)\s*:/i.test(el.getAttribute('style') ?? '')) add(el, 'color-token', 'Color definido en style en lugar de los tokens de diseño.');
  }
  return findings;
};
