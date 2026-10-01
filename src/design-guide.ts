import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { readTokens, tokensProblems, type Tokens } from './spec/tokens.ts';
import { frontMatter } from './story.ts';

export const DESIGN_SLUG = '00-design';
export const DESIGN_WORD_LIMIT = 500;
export type Reference = { source: string; role: 'target' | 'current' | 'constraint'; notes: string };
const roles = new Set(['target', 'current', 'constraint']);
const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
const cell = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

const atomic = async (file: string, text: string): Promise<void> => {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, 'utf8'); await rename(temp, file);
};

/** Explicitly authored specification, not an automatic synthesis of old guides. */
export const writeDesign = async (protoDir: string, markdown: string, references: readonly Reference[]): Promise<void> => {
  if (!markdown.trim() || markdown.length > 8_000) throw new Error('Design specification must be nonempty and at most 8000 characters.');
  if (!Array.isArray(references) || !references.length || references.length > 8) throw new Error('Provide 1–8 inspected references, with roles target/current/constraint.');
  for (const ref of references) {
    if (!ref || !roles.has(ref.role) || typeof ref.source !== 'string' || !ref.source.trim() || ref.source.length > 400
      || typeof ref.notes !== 'string' || !ref.notes.trim() || ref.notes.length > 300) throw new Error('Each reference needs a source, role and a concise concrete observation (not a claim of unverified fidelity).');
  }
  const body = `${markdown.trim()}\n\n## Referencias\n\n| Rol | Fuente | Observación |\n| --- | --- | --- |\n${references.map(r => `| ${r.role} | ${cell(r.source)} | ${cell(r.notes)} |`).join('\n')}\n`;
  const count = wordCount(body);
  if (count > DESIGN_WORD_LIMIT) throw new Error(`Design specification has ${count} words; limit ${DESIGN_WORD_LIMIT}. Link detailed evidence and token values instead of duplicating them. No file was changed.`);
  await mkdir(join(protoDir, 'guide'), { recursive: true });
  await atomic(join(protoDir, 'guide', `${DESIGN_SLUG}.md`), `---\ntitle: Diseño\norder: 0\n---\n\n${body}`);
};

export const readDesign = async (protoDir: string): Promise<string | undefined> => {
  const text = await readFile(join(protoDir, 'guide', `${DESIGN_SLUG}.md`), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (text && (text.length > 10_000 || wordCount(frontMatter(text).body) > DESIGN_WORD_LIMIT)) throw new Error('guide/00-design.md exceeds the compact specification budget. Condense it explicitly; read detailed evidence separately.');
  return text;
};

/** Merge specified tokens without deleting unrelated values or YAML comments. */
export const writeTokens = async (protoDir: string, changes: unknown): Promise<Tokens> => {
  const problems = tokensProblems(changes);
  if (problems.length) throw new Error(problems.join('; '));
  const patch = changes as Tokens;
  if (!Object.values(patch).some(group => Object.keys(group ?? {}).length)) throw new Error('Provide at least one token or component.');
  const previous = await readTokens(protoDir);
  const next = { ...previous, ...Object.fromEntries(Object.entries(patch).map(([group, values]) =>
    [group, { ...previous[group as keyof Tokens], ...values }])) } as Tokens;
  const invalid = tokensProblems(next);
  if (invalid.length) throw new Error(invalid.join('; '));
  const path = join(protoDir, 'guide', 'tokens.yaml');
  const document = YAML.parseDocument(await readFile(path, 'utf8').catch(() => '{}'));
  for (const [group, values] of Object.entries(patch)) for (const [name, value] of Object.entries(values)) document.setIn([group, name], value);
  await mkdir(join(protoDir, 'guide'), { recursive: true });
  await atomic(path, document.toString({ lineWidth: 0 }));
  return next;
};
