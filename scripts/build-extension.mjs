// Build the editor extension into extension/out from the shared sources (run `npm run build` first):
//   out/extension.cjs, webview.cjs   the extension (extension/src, compiled)
//   out/worker.mjs                    the analysis process
//   out/analyzer/                     the CLI's analyzer (dist/), without the native parsers, the CLI and its server
//   out/viewer/                       the CLI's viewer, with schema.js, Cytoscape, ELK and the fonts
//   out/wasm/                         the grammars' WebAssembly builds (web-tree-sitter itself is a dependency)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAMMAR_WASM } from '../dist/wasm-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const out = path.join(ext, 'out');
const require = createRequire(path.join(root, 'package.json'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!fs.existsSync(path.join(root, 'dist', 'analyze.js'))) throw new Error('dist/ is missing: run npm run build first');
execFileSync(process.execPath, [path.join(root, 'scripts', 'extension-manifest.mjs')], { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });

// The extension's own code.
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(ext, 'tsconfig.json')], { stdio: 'inherit' });
fs.copyFileSync(path.join(ext, 'src', 'worker.mjs'), path.join(out, 'worker.mjs'));

// The analyzer: compiled JavaScript and query files only.
const SKIP = new Set(['native', 'cli.js', 'server.js']);
function copyAnalyzer(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name) && from === path.join(root, 'dist')) continue;
    const src = path.join(from, e.name);
    if (e.isDirectory()) copyAnalyzer(src, path.join(to, e.name));
    else if (/\.(js|scm)$/.test(e.name)) fs.copyFileSync(src, path.join(to, e.name));
  }
}
copyAnalyzer(path.join(root, 'dist'), path.join(out, 'analyzer'));
// What src/brand.ts reads (one level above it), and the module type of the analyzer's files.
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, displayName: pkg.displayName, bin: pkg.bin, type: 'module', private: true }, null, 2) + '\n',
);

// The viewer, laid out so its relative paths (style.css, vendor/..., ./schema.js) resolve inside the webview.
const viewer = path.join(out, 'viewer');
fs.mkdirSync(path.join(viewer, 'vendor', 'fonts'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'viewer'))) if (/\.(html|js|css)$/.test(f)) fs.copyFileSync(path.join(root, 'viewer', f), path.join(viewer, f));
fs.copyFileSync(path.join(root, 'dist', 'schema.js'), path.join(viewer, 'schema.js'));
const vendor = {
  'cytoscape.min.js': require.resolve('cytoscape/dist/cytoscape.min.js'),
  'elk.bundled.js': require.resolve('elkjs/lib/elk.bundled.js'),
  'cytoscape-elk.js': require.resolve('cytoscape-elk/dist/cytoscape-elk.js'),
};
for (const [name, file] of Object.entries(vendor)) fs.copyFileSync(file, path.join(viewer, 'vendor', name));
for (const font of ['ibm-plex-sans', 'ibm-plex-mono', 'space-grotesk']) {
  const dir = path.join(path.dirname(require.resolve(`@fontsource/${font}/package.json`)), 'files');
  for (const f of fs.readdirSync(dir)) if (/-latin-\d+-normal\.woff2$/.test(f)) fs.copyFileSync(path.join(dir, f), path.join(viewer, 'vendor', 'fonts', f));
}

// The grammars' .wasm files, from the same grammar packages (and versions) as the native parsers.
const wasm = path.join(out, 'wasm');
fs.mkdirSync(wasm, { recursive: true });
const grammarPackage = { php: 'tree-sitter-php', ts: 'tree-sitter-typescript', tsx: 'tree-sitter-typescript', js: 'tree-sitter-javascript' };
for (const [lang, file] of Object.entries(GRAMMAR_WASM)) fs.copyFileSync(path.join(path.dirname(require.resolve(`${grammarPackage[lang]}/package.json`)), file), path.join(wasm, file));

// The root changelog and license ship with the extension (same versions, same license). The changelog's relative
// links point into the repository: absolute links to it when package.json names one, else their text only.
const repo = pkg.repository ? sourceUrl(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url) : null;
const changelog = fs
  .readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  .replace(/\[([^\]]+)\]\((?![a-z]+:)([^)]*)\)/g, (_, text, link) => (repo ? `[${text}](${repo}/blob/HEAD/${link})` : text));
fs.writeFileSync(path.join(ext, 'CHANGELOG.md'), changelog);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(ext, 'LICENSE'));

// Third-party notices, from the packages themselves: everything the .vsix contains code, grammars or fonts from.
/** A package's repository as a URL: "owner/repo", "github:owner/repo", "git@github.com:owner/repo" and git+ forms. */
function sourceUrl(repo) {
  const r = repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r}`;
  return r.replace(/^git@([^:]+):/, 'https://$1/').replace(/^(git|ssh):\/\/(git@)?/, 'https://');
}

function packageInfo(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
  return {
    name: meta.name,
    version: meta.version,
    license: typeof meta.license === 'string' ? meta.license : meta.license?.type ?? 'see below',
    source: sourceUrl(repo ?? meta.homepage ?? ''),
    text: file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : null,
  };
}
/**
 * The folders of the extension's production dependencies, transitively, resolved like Node does (nearest
 * node_modules first). Read from the manifests rather than `npm ls`, whose output masks id-like path segments.
 */
function productionDependencies(dir) {
  const found = new Set();
  const visit = (from, names) => {
    for (const name of names) {
      let d = from;
      let pkgDir = null;
      for (;;) {
        const candidate = path.join(d, 'node_modules', ...name.split('/'));
        if (fs.existsSync(path.join(candidate, 'package.json'))) {
          pkgDir = candidate;
          break;
        }
        if (d === ext || path.dirname(d) === d) break;
        d = path.dirname(d);
      }
      if (!pkgDir) throw new Error(`${name} (needed by ${path.relative(ext, from) || 'the extension'}) is not installed: run npm ci in extension/`);
      if (found.has(pkgDir)) continue;
      found.add(pkgDir);
      const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      visit(pkgDir, Object.keys(meta.dependencies ?? {}));
    }
  };
  visit(dir, Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies ?? {}));
  return [...found];
}

// Not require.resolve: some packages (cytoscape) don't export their package.json.
const fromRoot = (name) => path.join(root, 'node_modules', ...name.split('/'));
const bundled = [
  ...['cytoscape', 'cytoscape-elk', 'elkjs', '@fontsource/ibm-plex-sans', '@fontsource/ibm-plex-mono', '@fontsource/space-grotesk'].map((n) => [fromRoot(n), 'the viewer']),
  ...['tree-sitter-php', 'tree-sitter-typescript', 'tree-sitter-javascript'].map((n) => [fromRoot(n), 'the grammars (.wasm)']),
  ...productionDependencies(ext).map((d) => [d, 'the analyzer (runtime dependency)']),
];
const packages = bundled.map(([dir, use]) => ({ ...packageInfo(dir), use })).sort((a, b) => (a.name < b.name ? -1 : 1));
const notices = [
  '# Third-party notices',
  '',
  `The ${pkg.displayName} extension bundles the software below. Each package is listed with its license, then the license text as the package ships it. Generated by \`scripts/build-extension.mjs\`.`,
  '',
  '| Package | Version | License | Used for | Source |',
  '| --- | --- | --- | --- | --- |',
  ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} | ${p.use} | ${p.source || '-'} |`),
  '',
  ...packages.flatMap((p) => [`## ${p.name} ${p.version} (${p.license})`, '', p.source ? `Source: ${p.source}` : '', '', '```text', p.text ?? `No license file in the package; its package.json says ${p.license}.`, '```', '']),
].join('\n');
fs.writeFileSync(path.join(ext, 'THIRD_PARTY_NOTICES.md'), notices);

const count = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, String(f))).isFile()).length;
console.log(`built extension/out: ${count(out)} files (analyzer ${count(path.join(out, 'analyzer'))}, viewer ${count(viewer)}, wasm ${count(wasm)})`);
