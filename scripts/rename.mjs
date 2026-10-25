// Rename the product in one step, before the first publish.
//   node scripts/rename.mjs --npm <package-name> --command <command> --display "<Display Name>"
// package.json "name", "bin" and "displayName" are what the code reads (src/brand.ts derives the config
// file, the output directory and the titles from them). This also rewrites the prose: every whole-word
// "CodeMap" (display name) and "codemap" (command: codemap.config.json, .codemap, npx codemap, ...) in the
// sources, tests, viewer, docs and CI. Run it on a clean working tree and review the diff.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split(/\s*--/)
    .filter(Boolean)
    .map((a) => {
      const [k, ...v] = a.split(' ');
      return [k, v.join(' ').replace(/^"|"$/g, '')];
    }),
);
const { npm, command, display } = args;
if (!npm || !command || !display) {
  console.error('usage: node scripts/rename.mjs --npm <package-name> --command <command> --display "<Display Name>"');
  process.exit(1);
}
if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(npm) || !/^[a-z0-9][a-z0-9-]*$/.test(command)) {
  console.error('npm names and commands are lowercase letters, digits and dashes');
  process.exit(1);
}

const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const target = Object.values(pkg.bin)[0];
pkg.name = npm;
pkg.displayName = display;
pkg.bin = { [command]: target };
pkg.scripts = Object.fromEntries(Object.entries(pkg.scripts).map(([k, v]) => [k === 'codemap' ? command : k, v]));
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

const lockFile = path.join(root, 'package-lock.json');
if (fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.name = npm;
  if (lock.packages?.['']) {
    lock.packages[''].name = npm;
    if (lock.packages[''].bin) lock.packages[''].bin = { [command]: target };
  }
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}

const TEXT = /\.(ts|mjs|js|html|css|md|yml|sh)$/;
const SKIP = new Set(['node_modules', 'dist', '.git', 'fixtures', 'legacy', 'homes', 'rentalsph', '.codemap']);
const changed = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.') && e.name !== '.github') continue;
    const file = path.join(dir, e.name);
    if (e.isDirectory()) walk(file);
    else if (TEXT.test(e.name) && file !== fileURLToPath(import.meta.url)) {
      const before = fs.readFileSync(file, 'utf8');
      const after = before.replace(/\bCodeMap\b/g, display).replace(/\bcodemap\b/g, command);
      if (after !== before) {
        fs.writeFileSync(file, after);
        changed.push(path.relative(root, file));
      }
    }
  }
}
walk(root);
console.log(`package.json: name ${npm}, command ${command}, display name ${display}`);
console.log(`rewrote ${changed.length} files:\n  ${changed.join('\n  ')}`);
console.log(`Config files are now ${command}.config.json and the default output directory .${command}. Review the diff, then npm install && npm test.`);
