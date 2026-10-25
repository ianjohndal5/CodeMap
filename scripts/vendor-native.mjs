// Copy the prebuilt Tree-sitter binaries into dist/native, so the published package needs no native
// dependencies: nothing to compile, no install scripts, and none of the grammar packages' conflicting
// peer ranges for npm or pnpm to resolve. Only what runs is copied (N-API prebuilds for linux, darwin
// and win32 on x64 and arm64, node-types metadata, licenses), not the grammars' C sources.
//
// The core binding's Linux prebuilds come from native-prebuilds/ (scripts/build-linux-binding.sh):
// upstream's need GCC 13's libstdc++ and fail on Debian 12 and Ubuntu 22.04.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const out = path.join(root, 'dist', 'native');

/** node-types.json of each language a grammar package exports, keyed by its export name ('' = the module itself). */
const GRAMMARS = {
  'tree-sitter-php': { php: 'php/src/node-types.json', php_only: 'php_only/src/node-types.json' },
  'tree-sitter-typescript': { typescript: 'typescript/src/node-types.json', tsx: 'tsx/src/node-types.json' },
  'tree-sitter-javascript': { '': 'src/node-types.json' },
};

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

function vendor(pkg, files) {
  const src = path.dirname(require.resolve(`${pkg}/package.json`));
  const meta = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  const dir = path.join(out, pkg);
  fs.rmSync(dir, { recursive: true, force: true });
  copyDir(path.join(src, 'prebuilds'), path.join(dir, 'prebuilds'));
  fs.copyFileSync(path.join(src, 'LICENSE'), path.join(dir, 'LICENSE'));
  for (const [from, to] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
    fs.copyFileSync(path.join(src, from), path.join(dir, to));
  }
  return { dir, meta };
}

const manifest = (meta, main) =>
  JSON.stringify({ name: meta.name, version: meta.version, license: meta.license, description: `Prebuilt binaries of ${meta.name} ${meta.version}, vendored`, type: 'commonjs', main }, null, 2) + '\n';

// The core binding: its own index.js finds prebuilds/<platform>-<arch> with node-gyp-build.
{
  const { dir, meta } = vendor('tree-sitter', [['index.js', 'index.js']]);
  fs.writeFileSync(path.join(dir, 'package.json'), manifest(meta, 'index.js'));
  const rebuilt = path.join(root, 'native-prebuilds', 'tree-sitter');
  const version = fs.readFileSync(path.join(rebuilt, 'VERSION'), 'utf8').trim();
  if (version !== meta.version) {
    throw new Error(`native-prebuilds/tree-sitter was built from tree-sitter ${version}, but ${meta.version} is installed: run scripts/build-linux-binding.sh`);
  }
  // glibc builds replace upstream's; tree-sitter.musl.node is picked by node-gyp-build on Alpine.
  for (const file of ['linux-x64/tree-sitter.node', 'linux-x64/tree-sitter.musl.node', 'linux-arm64/tree-sitter.node']) {
    fs.copyFileSync(path.join(rebuilt, file), path.join(dir, 'prebuilds', file));
  }
}

// Grammars: the same loader as their bindings/node/index.js, with node-types next to it.
for (const [pkg, langs] of Object.entries(GRAMMARS)) {
  const { dir, meta } = vendor(
    pkg,
    Object.entries(langs).map(([name, file]) => [file, `node-types/${name || 'language'}.json`]),
  );
  const attach = Object.keys(langs)
    .map((name) => `  ${name ? `binding.${name}` : 'binding'}.nodeTypeInfo = require('./node-types/${name || 'language'}.json');`)
    .join('\n');
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `// Vendored loader for ${meta.name} ${meta.version} (see scripts/vendor-native.mjs).\nconst binding = require('node-gyp-build')(__dirname);\ntry {\n${attach}\n} catch (_) {}\nmodule.exports = binding;\n`,
  );
  fs.writeFileSync(path.join(dir, 'package.json'), manifest(meta, 'index.js'));
}

const platforms = fs.readdirSync(path.join(out, 'tree-sitter', 'prebuilds')).sort();
console.log(`vendored Tree-sitter binaries for ${platforms.join(', ')} into dist/native`);
