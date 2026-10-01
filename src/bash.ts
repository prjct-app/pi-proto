import { parse as shellParse } from 'shell-quote';

/**
 * The categories of writes a bash command can attempt. None means the
 * command does not write (reads, navigates, lists, no-op) and the guard
 * should pass it.
 */
export type BashIntent = 'none' | 'redirect' | 'modify' | 'destructive';

export type BashFinding = Readonly<{
  intent: BashIntent;
  /** Real paths involved in the write; in `redirect` mode this is the target. */
  paths: readonly string[];
}>;

const REDIRECT_TARGET = /(?:>>|>&|&>)\s*(?:"([^"]+)"|'([^']+)'|([^\s&|;]+))|(?:>)\s*(?:"([^"]+)"|'([^']+)'|([^\s&|;]+))/gu;
const SCDT_DESTRUCTIVE = /^(rm|rmdir|shred|truncate|unlink)$/u;
const SCDT_MODIFY = /^(sed|awk|tee|patch|install|chmod|chown|touch)$/u;
const SED_IN_PLACE = /^(-i)(?:\.\w+)?$/u;
const SCDT_COPY = /^(cp|mv|ln|rsync)$/u;

const flatten = (tokens: ReadonlyArray<unknown>): string[] => {
  const out: string[] = [];
  for (const t of tokens) {
    if (typeof t === 'string') out.push(t);
    else if (t && typeof t === 'object' && 'op' in t) {
      // operator token: skip the operator; nested args would be unusual in `parse`
    }
  }
  return out;
};

const splitBy = (command: string): string[] => {
  // Split on top-level control operators shell-quote does not capture. We keep
  // it simple and accept quoted semicolons; that's fine for tool inputs.
  return command.split(/[;&]+(?=(?:[^"'`]*["'`][^"'`]*["'`])*[^"'`]*$)/u).map(s => s.trim()).filter(Boolean);
};

const isPathLike = (s: string): boolean => /^~?\/|^\.{1,2}\/|^\/[^\s]/u.test(s) || s === '-' || s === '/dev/null';

const classifySegment = (segment: string): BashFinding => {
  const redirectTargets: string[] = [];
  for (const match of segment.matchAll(REDIRECT_TARGET)) {
    const target = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6];
    if (target) redirectTargets.push(target);
  }
  if (redirectTargets.length) {
    return { intent: 'redirect', paths: [...new Set(redirectTargets)] };
  }

  const tokens = flatten(shellParse(segment));
  if (!tokens.length) return { intent: 'none', paths: [] };
  const verb = tokens[0] ?? '';
  const args = tokens.slice(1).filter(s => !s.startsWith('-'));

  if (SCDT_DESTRUCTIVE.test(verb)) {
    const paths = args.filter(isPathLike);
    if (paths.length) return { intent: 'destructive', paths };
  }

  if (SCDT_COPY.test(verb)) {
    const last = args[args.length - 1];
    if (last && isPathLike(last)) return { intent: 'redirect', paths: [last] };
  }

  if (SCDT_MODIFY.test(verb)) {
    if (verb === 'sed' && tokens.some(t => SED_IN_PLACE.test(t))) {
      const paths = args.filter(isPathLike);
      if (paths.length) return { intent: 'modify', paths };
    }
    if (verb === 'tee') {
      const paths = args.filter(isPathLike);
      if (paths.length) return { intent: 'redirect', paths };
    }
    if (verb === 'touch' || verb === 'patch' || verb === 'install' || verb === 'chmod' || verb === 'chown') {
      const paths = args.filter(isPathLike);
      if (paths.length) return { intent: 'modify', paths };
    }
  }

  return { intent: 'none', paths: [] };
};

/** Heuristically classify a bash command. `none` means "no write to a file". */
export const classifyBash = (command: string): BashFinding => {
  if (!command.trim()) return { intent: 'none', paths: [] };
  const segments = splitBy(command);
  const findings: BashFinding[] = segments.map(classifySegment);
  const intentPriority: Record<BashIntent, number> = { none: 0, redirect: 1, modify: 2, destructive: 3 };
  const worst = findings.reduce<BashIntent>((acc, f) => intentPriority[f.intent] > intentPriority[acc] ? f.intent : acc, 'none');
  const paths = [...new Set(findings.flatMap(f => f.paths))];
  return { intent: worst, paths };
};
