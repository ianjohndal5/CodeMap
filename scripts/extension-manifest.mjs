// extension/package.json, generated from the root package.json: the extension's identifiers (name, commands,
// settings keys, view type) derive from the CLI's command name, its version is the CLI's, and its runtime
// dependencies are the analyzer's. Hand-edited fields (publisher, engines, dev dependencies, scripts) are kept.
//   node scripts/extension-manifest.mjs           write extension/package.json (and its lockfile's name and version)
//   node scripts/extension-manifest.mjs --check   exit 1 if they are out of date (a test checks the same)
// scripts/rename.mjs runs it after renaming, and `npm version` (the "version" script) before its commit, so a
// rename or a version bump covers the extension too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The manifest for `pkg` (root package.json), keeping the hand-edited fields of `current`. */
export function extensionManifest(pkg, current = {}) {
  const id = Object.keys(pkg.bin)[0];
  const name = pkg.displayName;
  const setting = (key, schema) => [`${id}.${key}`, schema];
  return {
    name: id,
    displayName: name,
    description: `${pkg.description}. Maps Laravel and Next.js code, the endpoints between them and an optional security lens, inside the editor; fully offline.`,
    version: pkg.version,
    publisher: current.publisher ?? 'seammap-placeholder',
    license: pkg.license,
    ...(pkg.repository ? { repository: pkg.repository } : {}),
    ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
    ...(pkg.bugs ? { bugs: pkg.bugs } : {}),
    engines: current.engines ?? { vscode: '^1.90.0' },
    categories: current.categories ?? ['Visualization', 'Other'],
    keywords: pkg.keywords,
    main: './out/extension.cjs',
    extensionKind: ['workspace'],
    capabilities: {
      untrustedWorkspaces: {
        supported: 'limited',
        description: `In Restricted Mode, ${name} still maps the code (it only reads files and never runs them) but ignores the "security" section of the workspace's ${id}.config.json: an untrusted config could classify middleware so that unprotected routes look protected.`,
        restrictedConfigurations: [`${id}.configFile`],
      },
    },
    activationEvents: [`onWebviewPanel:${id}.map`],
    contributes: {
      commands: [
        { command: `${id}.open`, title: 'Open Map', category: name, icon: '$(type-hierarchy)' },
        { command: `${id}.refresh`, title: 'Refresh Map', category: name, icon: '$(refresh)' },
        { command: `${id}.revealFile`, title: 'Show Current File on Map', category: name },
      ],
      menus: {
        commandPalette: [{ command: `${id}.revealFile`, when: 'editorIsOpen' }],
        'editor/title': [{ command: `${id}.revealFile`, when: `activeWebviewPanelId != '${id}.map' && resourceScheme == file && ${id}.mapOpen`, group: 'navigation@99' }],
      },
      configuration: {
        title: name,
        properties: Object.fromEntries([
          setting('backend', { type: 'string', default: '', scope: 'resource', markdownDescription: `Laravel project root, relative to the workspace folder (like \`--backend\`). Empty: from \`${id}.config.json\`, else detected.` }),
          setting('frontend', { type: 'string', default: '', scope: 'resource', markdownDescription: `Next.js project root, relative to the workspace folder (like \`--frontend\`). Empty: from \`${id}.config.json\`, else detected.` }),
          setting('configFile', { type: 'string', default: '', scope: 'resource', markdownDescription: `Config file to use, relative to the workspace folder (like \`--config\`). Empty: the nearest \`${id}.config.json\` in or above the projects, as the command line looks for it.` }),
          setting('security', { type: 'boolean', default: false, scope: 'resource', markdownDescription: 'Add the security lens (like `--security`): route protection signals for review. A review aid, not a scanner.' }),
        ]),
      },
    },
    scripts: current.scripts ?? {},
    dependencies: {
      'fast-glob': pkg.dependencies['fast-glob'],
      ignore: pkg.dependencies.ignore,
      'web-tree-sitter': pkg.devDependencies['web-tree-sitter'],
    },
    devDependencies: current.devDependencies ?? {},
  };
}

/** extension/package-lock.json with the manifest's name and version (npm writes both into its root entry). */
export function extensionLock(lock, manifest) {
  const root = lock.packages?.[''];
  return { ...lock, name: manifest.name, version: manifest.version, ...(root ? { packages: { ...lock.packages, '': { ...root, name: manifest.name, version: manifest.version } } } : {}) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = path.join(root, 'extension', 'package.json');
  const lockFile = path.join(root, 'extension', 'package-lock.json');
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const current = fs.existsSync(file) ? JSON.parse(read(file)) : {};
  const manifest = extensionManifest(pkg, current);
  const outputs = [[file, JSON.stringify(manifest, null, 2) + '\n']];
  if (fs.existsSync(lockFile)) outputs.push([lockFile, JSON.stringify(extensionLock(JSON.parse(read(lockFile)), manifest), null, 2) + '\n']);
  const stale = outputs.filter(([f, text]) => read(f) !== text);
  if (process.argv.includes('--check')) {
    if (stale.length) {
      console.error(`${stale.map(([f]) => path.relative(root, f)).join(' and ')} out of date with package.json: run node scripts/extension-manifest.mjs`);
      process.exit(1);
    }
  } else {
    for (const [f, text] of stale) {
      fs.writeFileSync(f, text);
      console.log(`wrote ${path.relative(root, f)}`);
    }
  }
}
