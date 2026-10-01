import { marked } from 'marked';
import { frontMatter } from './story.ts';

/**
 * A guide page as a standalone document. It loads the prototypes' compiled
 * main.css, so a guide can show real tokens and components with the same
 * Tailwind classes the prototypes use; Markdown may carry raw HTML for that.
 */
export const guideDocument = (markdown: string, title: string, cssHref = '/p/main.css'): string => {
  const { body } = frontMatter(markdown);
  const html = marked.parse(body, { async: false, gfm: true }) as string;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<link rel="stylesheet" href="${cssHref}">
<style>
  .proto-guide { max-width: 860px; margin: 0 auto; padding: 40px 32px 96px; font: 15px/1.65 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #1c1c1e; }
  .proto-guide h1:not([data-proto-example] *) { font-size: 30px; line-height: 1.2; font-weight: 700; margin: 0 0 20px; letter-spacing: -0.01em; }
  .proto-guide h2:not([data-proto-example] *) { font-size: 21px; font-weight: 650; margin: 36px 0 12px; }
  .proto-guide h3:not([data-proto-example] *) { font-size: 17px; font-weight: 600; margin: 28px 0 8px; }
  .proto-guide :is(p, ul, ol, table, pre):not([data-proto-example] *) { margin: 0 0 14px; }
  .proto-guide ul:not([data-proto-example] *) { list-style: disc; padding-left: 22px; }
  .proto-guide ol:not([data-proto-example] *) { list-style: decimal; padding-left: 22px; }
  .proto-guide a:not([data-proto-example] *) { color: #2f5bd3; text-decoration: underline; }
  .proto-guide code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f2f2f4; padding: 1px 5px; border-radius: 4px; }
  .proto-guide pre { background: #f2f2f4; padding: 14px 16px; border-radius: 8px; overflow: auto; }
  .proto-guide pre code { background: none; padding: 0; }
  .proto-guide table { border-collapse: collapse; width: 100%; }
  .proto-guide th, .proto-guide td { border-bottom: 1px solid #e5e5ea; padding: 8px 10px; text-align: left; vertical-align: top; }
  .proto-guide blockquote { border-left: 3px solid #d1d1d6; padding-left: 14px; color: #555; margin: 0 0 14px; }
  .proto-guide hr { border: 0; border-top: 1px solid #e5e5ea; margin: 28px 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #111113; }
    .proto-guide { color: #ececf0; }
    .proto-guide code, .proto-guide pre { background: #1d1d21; }
    .proto-guide th, .proto-guide td { border-color: #2c2c31; }
    .proto-guide a:not([data-proto-example] *) { color: #8fb0ff; }
  }
</style>
</head>
<body><article class="proto-guide">${html}</article></body>
</html>
`;
};
