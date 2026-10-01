import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DarkMode, StackId, StylingId } from './config.ts';
import { detectRoutes } from './detect-routes.ts';

/** One observable the detection found in the project. */
export type Finding = Readonly<{
  /** Where the signal came from (file path or directory). */
  source: string;
  /** What was detected. */
  kind: 'framework' | 'styling' | 'ui-library' | 'dark-mode' | 'routes' | 'docs';
  /** The actual value (e.g. "next", "tailwind4", "@heroui/styles"). */
  value: string;
}>;

export type DetectionResult = Readonly<{
  /** Best guess at the framework/stack. */
  stack: StackId;
  /** Which CSS adapter the build should use. */
  styling: StylingId;
  /** Path (relative to frontendRoot) of the CSS entry to compile. */
  cssEntry: string | undefined;
  /** Path (relative to frontendRoot) of the public assets directory. */
  publicDir: string | undefined;
  /** UI library whose CSS is loaded directly (e.g. `@heroui/styles`, daisyUI). */
  uiLibrary: string | undefined;
  /** Project's dark-mode convention. */
  darkMode: DarkMode;
  /** Realpath of the project root. */
  frontendRoot: string;
  /** All routes discovered, in source order. */
  routes: readonly string[];
  /** Existing design docs the guide generator can import. */
  docs: readonly string[];
  /** Raw findings, for the agent to inspect or override. */
  findings: readonly Finding[];
}>;

const exists = (root: string, ...parts: readonly string[]): boolean => existsSync(join(root, ...parts));

const readJson = async (root: string, file: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const text = await readFile(join(root, file), 'utf8');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const readText = async (root: string, file: string): Promise<string | undefined> => {
  try {
    return await readFile(join(root, file), 'utf8');
  } catch {
    return undefined;
  }
};

const allDeps = (pkg: Record<string, unknown>): Record<string, string> => ({
  ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
});

const detectFramework = (
  root: string,
  all: Record<string, string>,
  findings: Finding[],
): { stack: StackId; styling: StylingId } => {
  const hasNext = 'next' in all;
  const hasAstro = 'astro' in all;
  const hasVue = 'vue' in all;
  const hasReact = 'react' in all;
  const hasTailwind = 'tailwindcss' in all;
  const twVersion = all.tailwindcss ?? '';
  const isTw4 = /^(?:workspace:)?[\^~]?4(?:\.|$)/u.test(twVersion);

  if (hasNext) {
    findings.push({ kind: 'framework', value: 'next', source: 'package.json' });
    if (hasTailwind && isTw4) {
      findings.push({ kind: 'styling', value: 'tailwind4-postcss', source: 'package.json' });
      return { stack: 'next-tailwind4', styling: 'tw4-postcss' };
    }
    if (hasTailwind && !isTw4) {
      findings.push({ kind: 'styling', value: 'tailwind3', source: 'package.json' });
      return { stack: 'next-tailwind3', styling: 'tw3' };
    }
    return { stack: 'next-tailwind4', styling: 'plain' };
  }
  if (hasAstro) {
    findings.push({ kind: 'framework', value: 'astro', source: 'package.json' });
    if (hasTailwind && isTw4) {
      findings.push({ kind: 'styling', value: 'tailwind4-vite', source: 'package.json' });
      return { stack: 'astro', styling: 'tw4-node' };
    }
    if (hasTailwind) {
      findings.push({ kind: 'styling', value: 'tailwind3', source: 'package.json' });
      return { stack: 'astro', styling: 'tw3' };
    }
    return { stack: 'astro', styling: 'plain' };
  }
  if (hasVue) {
    findings.push({ kind: 'framework', value: 'vue', source: 'package.json' });
    if (hasTailwind && isTw4) {
      findings.push({ kind: 'styling', value: 'tailwind4-vite', source: 'package.json' });
      return { stack: 'vue', styling: 'tw4-node' };
    }
    if (hasTailwind) {
      findings.push({ kind: 'styling', value: 'tailwind3', source: 'package.json' });
      return { stack: 'vue', styling: 'tw3' };
    }
    return { stack: 'vue', styling: 'plain' };
  }
  if (hasTailwind && isTw4) {
    findings.push({ kind: 'styling', value: 'tailwind4-postcss', source: 'package.json' });
    return { stack: 'html-tailwind4', styling: 'tw4-postcss' };
  }
  if (hasTailwind) {
    findings.push({ kind: 'styling', value: 'tailwind3', source: 'package.json' });
    return { stack: 'html-tailwind4', styling: 'tw3' };
  }
  if (hasReact) {
    findings.push({ kind: 'framework', value: 'react', source: 'package.json' });
    return { stack: 'plain', styling: 'plain' };
  }
  findings.push({ kind: 'framework', value: 'html', source: exists(root, 'index.html') ? 'index.html' : root });
  return { stack: 'plain', styling: 'plain' };
};

const detectUiLibrary = (all: Record<string, string>, findings: Finding[]): string | undefined => {
  const candidates = ['@heroui/react', '@heroui/styles', '@heroui/theme', '@nextui-org/react', '@mui/material', '@mantine/core', '@chakra-ui/react', 'antd', 'daisyui', '@shadcn/ui', 'bootstrap'];
  for (const name of candidates) if (name in all) {
    findings.push({ kind: 'ui-library', value: name, source: 'package.json' });
    return name;
  }
  return undefined;
};

const detectCssEntry = (stack: StackId): readonly string[] => {
  if (stack === 'next-tailwind4' || stack === 'next-tailwind3') {
    return ['src/app/globals.css', 'app/globals.css', 'src/styles/globals.css', 'styles/globals.css'];
  }
  if (stack === 'astro' || stack === 'vue') {
    return ['src/styles/global.css', 'src/styles/globals.css', 'src/app.css', 'src/main.css', 'styles/global.css'];
  }
  return ['src/styles.css', 'src/main.css', 'styles.css', 'main.css', 'index.css', 'css/main.css', 'css/styles.css'];
};

const detectPublicDir = (stack: StackId): readonly string[] => {
  if (stack === 'astro') return ['public'];
  if (stack.startsWith('next-')) return ['public', 'src/public'];
  return ['public'];
};

const detectDarkMode = async (
  root: string,
  cssEntry: string | undefined,
  tailwindConfig: string | undefined,
  findings: Finding[],
): Promise<DarkMode> => {
  if (cssEntry) {
    const text = await readText(root, cssEntry);
    if (text) {
      if (/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/u.test(text)) {
        findings.push({ kind: 'dark-mode', value: 'media', source: cssEntry });
        return 'media';
      }
      if (/\.dark\b/u.test(text)) {
        findings.push({ kind: 'dark-mode', value: 'class', source: cssEntry });
        return 'class';
      }
      if (/\[data-theme=["']?dark["']?\]/u.test(text) || /data-mode=["']?dark/u.test(text)) {
        findings.push({ kind: 'dark-mode', value: 'attribute', source: cssEntry });
        return 'attribute';
      }
    }
  }
  if (tailwindConfig) {
    const configText = await readText(root, tailwindConfig);
    if (configText && /darkMode\s*:\s*['"]class['"]/u.test(configText)) {
      findings.push({ kind: 'dark-mode', value: 'class', source: 'tailwind.config' });
      return 'class';
    }
  }
  findings.push({ kind: 'dark-mode', value: 'class', source: 'default' });
  return 'class';
};

export const detectDocs = (root: string, findings: Finding[]): readonly string[] => {
  const candidates = [
    'DESIGN.md', 'docs/DESIGN.md', '.impeccable/DESIGN.md', 'design/DESIGN.md',
    '.impeccable/front-end-guidelines.md', 'docs/front-end-guidelines.md',
    'design-tokens.json', 'tokens.json', 'docs/design-tokens.json',
  ];
  const all: string[] = [];
  for (const c of candidates) {
    all.push(c);
    if (exists(root, c)) findings.push({ kind: 'docs', value: c, source: c });
  }
  return all;
};

/**
 * Detect a project's stack from its files. Pure: no writes, no network.
 * Returns findings so the caller (proto_init) can show what was inferred and
 * let the user correct a wrong guess with one tool call.
 */
export const detectStack = async (frontendRoot: string, options: { routes?: boolean } = {}): Promise<DetectionResult> => {
  const findings: Finding[] = [];
  const pkg = await readJson(frontendRoot, 'package.json');
  if (!pkg) throw new Error(`No package.json at ${frontendRoot}; proto_init needs a project root with one.`);
  const all = allDeps(pkg);
  const detected = detectFramework(frontendRoot, all, findings);
  const uiLibrary = detectUiLibrary(all, findings);

  const cssEntry = detectCssEntry(detected.stack).find(candidate => exists(frontendRoot, candidate));

  // Scan CSS files and postcss configs for tailwind when deps don't mention
  // it (CDN install via the standalone CLI or a separate @tailwindcss/postcss).
  const { stack } = detected;
  const styling = { value: detected.styling };
  if (styling.value === 'plain') {
    if (cssEntry) {
      const text = await readText(frontendRoot, cssEntry);
      if (text && /@import\s+["']tailwindcss["']/u.test(text)) {
        styling.value = 'tw4-postcss';
        findings.push({ kind: 'styling', value: 'tailwind4-postcss', source: cssEntry });
      }
    }
    if (styling.value === 'plain') {
      const postcssFile = ['postcss.config.mjs', 'postcss.config.js', 'postcss.config.cjs']
        .find(candidate => exists(frontendRoot, candidate));
      if (postcssFile) {
        const text = await readText(frontendRoot, postcssFile);
        if (text && /@tailwindcss\/postcss/u.test(text)) {
          styling.value = 'tw4-postcss';
          findings.push({ kind: 'styling', value: 'tailwind4-postcss', source: postcssFile });
        } else if (text && /tailwindcss[^a-zA-Z]/u.test(text) && !/tailwindcss:[\s\S]*v4/u.test(text)) {
          styling.value = 'tw3';
          findings.push({ kind: 'styling', value: 'tailwind3', source: postcssFile });
        }
      }
    }
  }

  const publicDir = detectPublicDir(stack).find(candidate => exists(frontendRoot, candidate));
  const tailwindConfigPath = ['tailwind.config.ts', 'tailwind.config.js']
    .find(candidate => exists(frontendRoot, candidate));

  const darkMode = await detectDarkMode(frontendRoot, cssEntry, tailwindConfigPath, findings);
  const routes = options.routes === false ? [] : detectRoutes(frontendRoot, stack, findings);
  const docs = detectDocs(frontendRoot, findings);
  return {
    stack,
    styling: styling.value,
    cssEntry,
    publicDir,
    uiLibrary,
    darkMode,
    frontendRoot,
    routes,
    docs,
    findings,
  };
};
