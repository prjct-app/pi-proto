import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return walk(path);
  return entry.isFile() && path.endsWith('.ts') ? [path] : [];
});

const offences = walk('src').flatMap(path => {
  const text = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Let)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      found.push(`${path}:${line + 1}:${character + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
});

if (offences.length) {
  console.error(`Use immutable values: no let bindings in src/\n${offences.map(place => `  ${place}`).join('\n')}`);
  process.exit(1);
}
if (statSync('src').isDirectory()) console.log('check:immutable ok — no let bindings in src/');
