// Copy Tree-sitter query files (*.scm) next to the compiled JavaScript.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const lang of ['js', 'php']) {
  const from = path.join(root, 'src', 'lang', lang, 'queries');
  const to = path.join(root, 'dist', 'lang', lang, 'queries');
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) if (f.endsWith('.scm')) fs.copyFileSync(path.join(from, f), path.join(to, f));
}
