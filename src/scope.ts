/** A conservative guard for clearly bounded artifact requests, not a general intent model. */
export type TaskScope = 'tokens' | 'guide' | 'foundation' | undefined;
const normalized = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export const taskScope = (prompt: string): TaskScope => {
  const marker = /^\[prototype task: (tokens|guide|prototype)\]/.exec(normalized(prompt))?.[1];
  if (marker) return marker === 'prototype' ? undefined : marker as TaskScope;
  const text = normalized(prompt).replace(/^\[(?:storybook|prototype)[^\n]*\]\n/, '').split(/\[(?:storybook|prototype) element/)[0]!;
  // Remove prohibitions before checking whether screen work was requested.
  const affirmative = text.replace(/\b(?:no|sin|without|don't|do not|not)\b[^,.;\n]*(?:[,.;\n]|$)/g, '');
  const action = '(?:gener\\w*|cre\\w*|extra\\w*|defin\\w*|actuali\\w*|escri\\w*|haz\\w*|hacer|saca\\w*|necesit\\w*|quier\\w*|dame|document\\w*|disena\\w*|write|generate|create|extract|update|build|design|need|want)';
  if (new RegExp(`\\b${action}\\s+(?:(?:un|una|el|la|los|las|a|an|the|nuevo|nueva)\\s+){0,3}(?:prototipo|prototype|pantallas?|screens?|mockup|wireframe)\\b`).test(affirmative)
    || /\bprototipa\w*\b|\b(?:prototype|disena)\s+(?:el |un |the |a )?(?:checkout|flujo|flow)\b/.test(affirmative)) return undefined;
  const tokens = new RegExp(`\\b${action}\\b[^.;\\n]{0,40}\\b(?:tokens|tockens)\\b`).test(affirmative);
  const guide = new RegExp(`\\b${action}\\b[^.;\\n]{0,65}\\b(?:documento|document|guias?|guides?|especificacion|specification|linea de diseno)\\b`).test(affirmative);
  if (tokens && guide) return 'foundation';
  if (tokens) return 'tokens';
  if (guide) return 'guide';
  // A prohibition also protects a short follow-up such as "solo tokens".
  if (/\b(?:solo|solamente|only|just)\s+(?:los\s+)?(?:tokens|tockens)\b/.test(text)) return 'tokens';
  return undefined;
};

export const scopeViolation = (scope: TaskScope, tool: string, input: unknown): string | undefined => {
  if (!scope) return undefined;
  const data = (input ?? {}) as Record<string, unknown>;
  if (['proto_edit', 'proto_create', 'proto_create_prototype', 'proto_create_page', 'proto_revert'].includes(tool)
    || (tool === 'proto_history' && data['revert_to'] !== undefined)
    || (['proto_init', 'proto_open'].includes(tool) && data['artifact'] === 'prototype')) {
    return `This request is ${scope}-only. Prototype changes were not requested. Complete the requested ${scope === 'tokens' ? 'tokens' : scope === 'guide' ? 'design document' : 'tokens and document'} and stop; ask before expanding scope.`;
  }
  if (scope === 'tokens' && (tool === 'proto_design' && data['markdown'] !== undefined)) return 'Tokens only: do not write a separate design document unless requested.';
  if (scope === 'guide' && tool === 'proto_tokens' && data['tokens'] !== undefined) return 'Design document only: read existing tokens, do not change them unless requested.';
  return undefined;
};

/** Protect common file-writing escape paths as well as the native proto tools. */
export const scopeFileViolation = (scope: TaskScope, path: string, request: string): string | undefined => {
  if (!scope) return undefined;
  const name = path.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const tokenFile = /(?:^|[.-])tokens\.(?:ya?ml|json|css|ts)$/.test(name);
  const namedCss = /\.css$/.test(name) && request.includes(name);
  if ((scope !== 'guide' && (tokenFile || namedCss)) || (scope !== 'tokens' && /\.md$/.test(name))) return undefined;
  return `This is ${scope}-only; writing ${name} would expand the requested artifact. Use proto_tokens/proto_design, or ask for permission to change application/prototype files.`;
};
