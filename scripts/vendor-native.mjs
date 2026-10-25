// Copy the prebuilt Tree-sitter binaries into dist/native, so the published package needs no native
// dependencies: nothing to compile, no install scripts, and none of the grammar packages' conflicting
// peer ranges for npm or pnpm to resolve. Only what runs is copied (N-API prebuilds for linux, darwin
// and win32 on x64 and arm64, node-types metadata, licenses), not the grammars' C sources.
//
// Some upstream prebuilds must not ship (REQUIRED says which and why): native-prebuilds/ holds the
// replacements (built by .github/workflows/native-prebuilds.yml), copied over upstream's here. A missing one
// is a warning in a development build and an error with --check, which `npm pack` runs.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const out = path.join(root, 'dist', 'native');
const replacements = path.join(root, 'native-prebuilds');

/** The replacements native-prebuilds/ must hold, per package (paths under prebuilds/). */
const REQUIRED = {
  // Upstream's are Node-API 10 builds, which crash on load in Node 20 and in Node 22 before 22.14; the Linux
  // ones also need GCC 13's libstdc++ (not on Debian 12 or Ubuntu 22.04). Upstream has no musl build.
  'tree-sitter': ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']
    .map((platform) => `${platform}/tree-sitter.node`)
    .concat('linux-x64/tree-sitter.musl.node'),
  // Upstream's linux-arm64 prebuild is an x86-64 binary.
  'tree-sitter-typescript': ['linux-arm64/tree-sitter-typescript.node'],
};

/** Why native-prebuilds/<pkg> cannot be used at all: absent, or built from another version than the installed one. */
function versionProblem(pkg) {
  const installed = require(`${pkg}/package.json`).version;
  const versionFile = path.join(replacements, pkg, 'VERSION');
  const built = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : undefined;
  if (built !== installed) return `native-prebuilds/${pkg} is ${built ? `from version ${built}` : 'missing'}, but ${installed} is installed`;
}

const problems = (pkg) => {
  const version = versionProblem(pkg);
  if (version) return [version];
  return REQUIRED[pkg].filter((f) => !fs.existsSync(path.join(replacements, pkg, f))).map((f) => `native-prebuilds/${pkg}/${f} is missing`);
};

if (process.argv.includes('--check')) {
  const found = Object.keys(REQUIRED).flatMap(problems);
  if (found.length) {
    console.error(`Refusing to package upstream Tree-sitter binaries that fail on some platforms (see native-prebuilds/README.md):\n  ${found.join('\n  ')}\nRun the native-prebuilds workflow, unpack its artifact into native-prebuilds/ and commit it.`);
    process.exit(1);
  }
  process.exit(0);
}

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

/** Copy native-prebuilds/<pkg>/<platform>/* over upstream's prebuilds, when they are from the installed version. */
function replace(pkg, dir) {
  for (const p of problems(pkg)) console.warn(`warning: ${p}: upstream's binary is used, and npm pack refuses it`);
  if (versionProblem(pkg)) return;
  for (const platform of fs.readdirSync(path.join(replacements, pkg), { withFileTypes: true })) {
    if (!platform.isDirectory()) continue;
    for (const file of fs.readdirSync(path.join(replacements, pkg, platform.name))) {
      fs.mkdirSync(path.join(dir, 'prebuilds', platform.name), { recursive: true });
      fs.copyFileSync(path.join(replacements, pkg, platform.name, file), path.join(dir, 'prebuilds', platform.name, file));
    }
  }
}

// The core binding: its own index.js finds prebuilds/<platform>-<arch> with node-gyp-build (and
// tree-sitter.musl.node on Alpine).
{
  const { dir, meta } = vendor('tree-sitter', [['index.js', 'index.js']]);
  fs.writeFileSync(path.join(dir, 'package.json'), manifest(meta, 'index.js'));
  replace('tree-sitter', dir);
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
  if (pkg in REQUIRED) replace(pkg, dir);
}

const platforms = fs.readdirSync(path.join(out, 'tree-sitter', 'prebuilds')).sort();
console.log(`vendored Tree-sitter binaries for ${platforms.join(', ')} into dist/native`);
