// extension/package.json, generated from the root package.json: the extension's identifiers (name, commands,
// settings keys, view type) derive from the CLI's command name, its version is the CLI's, and its runtime
// dependencies are the analyzer's. Hand-edited fields (publisher, engines, dev dependencies, scripts) are kept.
//   node scripts/extension-manifest.mjs           write extension/package.json
//   node scripts/extension-manifest.mjs --check   exit 1 if it is out of date (a test runs this)
// scripts/rename.mjs runs it after renaming, so a rename covers the extension too.
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
    publisher: current.publisher ?? 'codemap-placeholder',
    license: pkg.license,
    ...(pkg.repository ? { repository: pkg.repository } : {}),
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = path.join(root, 'extension', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const text = JSON.stringify(extensionManifest(pkg, current), null, 2) + '\n';
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (text !== before) {
      console.error('extension/package.json is out of date with package.json: run node scripts/extension-manifest.mjs');
      process.exit(1);
    }
  } else if (text !== before) {
    fs.writeFileSync(file, text);
    console.log('wrote extension/package.json');
  }
}
