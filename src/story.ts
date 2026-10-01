import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The design guide's pages, discovered from guide/*.md: ordered by front
 * matter `order` or the file's number, titled by front matter or the first
 * heading. The generated pages (tokens, sitemap) are among them.
 */

export type GuidePage = Readonly<{
  slug: string;
  title: string;
  order: number;
  file: string;
  updatedAt: number;
}>;

const mtime = (path: string): Promise<number> => stat(path).then(s => s.mtimeMs, () => 0);

const slugTitle = (slug: string): string => {
  const words = slug.replace(/^\d+[-_.\s]*/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : slug;
};

/** `---\nkey: value\n---` at the top of a markdown file. */
export const frontMatter = (text: string): { data: Record<string, string>; body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = Object.fromEntries(match[1]!.split(/\r?\n/).flatMap(line => {
    const at = line.indexOf(':');
    return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, '')]] : [];
  }));
  return { data, body: text.slice(match[0].length) };
};

const htmlText = (value: string): string => value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export const readGuides = async (protoDir: string): Promise<GuidePage[]> => {
  const dir = join(protoDir, 'guide');
  const names = await readdir(dir).catch(() => [] as string[]);
  const pages = await Promise.all(names.filter(name => name.endsWith('.md') && !name.startsWith('.')).map(async (name): Promise<GuidePage> => {
    const file = join(dir, name);
    const slug = name.replace(/\.md$/, '');
    const { data, body } = frontMatter(await readFile(file, 'utf8').catch(() => ''));
    const heading = /^#\s+(.+)$/m.exec(body)?.[1];
    const prefix = /^(\d+)/.exec(slug)?.[1];
    return {
      slug,
      title: data['title'] || (heading ? htmlText(heading) : slugTitle(slug)),
      order: Number(data['order'] ?? prefix ?? 1000),
      file,
      updatedAt: await mtime(file),
    };
  }));
  return pages.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
};

