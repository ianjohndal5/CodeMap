// Rename the product in one step, before the first publish.
//   node scripts/rename.mjs --npm <package-name> --command <command> --display "<Display Name>" [--publisher <id>]
// package.json "name", "bin" and "displayName" are what the code reads (src/brand.ts derives the config
// file, the output directory and the titles from them). This also rewrites the prose: every whole-word
// "CodeMap" (display name) and "codemap" (command: codemap.config.json, .codemap, npx codemap, ...) in the
// sources, tests, viewer, docs, CHANGELOG.md and CI. The editor extension follows: its identifiers (extension name,
// commands, settings keys, view type) are regenerated from package.json, and --publisher sets its Marketplace /
// Open VSX publisher (the extension's id is <publisher>.<command>). Run it on a clean working tree, review the diff.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionManifest } from './extension-manifest.mjs';

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
const { npm, command, display, publisher } = args;
if (!npm || !command || !display) {
  console.error('usage: node scripts/rename.mjs --npm <package-name> --command <command> --display "<Display Name>" [--publisher <id>]');
  process.exit(1);
}
if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(npm) || !/^[a-z0-9][a-z0-9-]*$/.test(command) || (publisher && !/^[a-z0-9][a-z0-9-]*$/i.test(publisher))) {
  console.error('npm names, commands and publishers are letters, digits and dashes (npm names and commands lowercase)');
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

const TEXT = /\.(ts|cts|mts|mjs|cjs|js|html|css|md|yml|sh)$/;
const SKIP = new Set(['node_modules', 'dist', 'out', 'dist-extension', '.git', 'fixtures', 'legacy', 'homes', 'rentalsph', '.codemap']);
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

// The extension: its manifest is generated from package.json (identifiers), its lockfile carries its name.
const extFile = path.join(root, 'extension', 'package.json');
if (fs.existsSync(extFile)) {
  const current = JSON.parse(fs.readFileSync(extFile, 'utf8'));
  if (publisher) current.publisher = publisher;
  fs.writeFileSync(extFile, JSON.stringify(extensionManifest(pkg, current), null, 2) + '\n');
  const extLock = path.join(root, 'extension', 'package-lock.json');
  if (fs.existsSync(extLock)) {
    const lock = JSON.parse(fs.readFileSync(extLock, 'utf8'));
    lock.name = command;
    if (lock.packages?.['']) lock.packages[''].name = command;
    fs.writeFileSync(extLock, JSON.stringify(lock, null, 2) + '\n');
  }
  changed.push('extension/package.json', 'extension/package-lock.json');
}
console.log(`package.json: name ${npm}, command ${command}, display name ${display}${publisher ? `; extension publisher ${publisher}` : ''}`);
console.log(`rewrote ${changed.length} files:\n  ${changed.join('\n  ')}`);
console.log(`Config files are now ${command}.config.json and the default output directory .${command}. Review the diff, then npm install && npm test.`);
