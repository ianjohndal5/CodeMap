# Publishing checklist (owner)

Everything is prepared so that publishing is a final step you perform. Nothing has been published, and no
accounts or tokens were created. `package.json` has `"private": true`, so `npm publish` refuses until you
remove it.

## 1. Choose the name

`codemap` is a placeholder. It is taken on npm (`codemap` 1.3.2, and `code-map`), and the VS Code Marketplace
already has several "CodeMap" extensions, one of them long established (`oleg-shilo.codemap`). These names were
free on npm, the Marketplace and Open VSX on 2026-10-25 (check again before deciding; npm also rejects names that
only differ by punctuation from an existing one, so `stack-map` or `route-lens` will not work):

| npm / command | Display name | Why |
| --- | --- | --- |
| `bridgemap` | BridgeMap | The endpoint lane is the bridge between the two stacks; short, says "map". |
| `seammap` | SeamMap | Maps the seam between frontend and backend, where bugs and access gaps hide. |
| `stackseam` | StackSeam | Same idea, reads as one word; less obviously a visualizer. |

A scoped name (`@yourname/codemap`) is always available too, but it is longer to type in `npx`.

Then rename everything in one step on a clean working tree, and review the diff:

```bash
node scripts/rename.mjs --npm bridgemap --command bridgemap --display BridgeMap
npm install && npm test
```

It sets `name`, `bin` and `displayName` in `package.json` (the code derives the command, the config file name
`<command>.config.json`, the output directory `.<command>` and the titles from them) and rewrites the prose in
sources, tests, viewer, docs and CI.

## 2. License

`package.json` says `MIT`, but the repository has no `LICENSE` file. Decide the license, then add a `LICENSE`
file with your name as the copyright holder (npm includes it in the package automatically).

What ships: the package contains its own code plus prebuilt Tree-sitter binaries (MIT; their `LICENSE` files are
copied next to them in `dist/native/*`). Runtime dependencies are installed by npm, not bundled: Cytoscape,
cytoscape-elk, commander, fast-glob, ignore and node-gyp-build (MIT), ELK (`elkjs`, EPL-2.0) and the
`@fontsource` fonts (SIL OFL 1.1). The VS Code extension will bundle some of these, so it will need a
third-party notices file.

## 3. Package metadata

In `package.json`:

* remove `"private": true`;
* add `"repository"` (e.g. `{ "type": "git", "url": "https://github.com/you/bridgemap" }`), `"homepage"` and
  `"bugs"`. With `repository` set, npm resolves the README's relative image links against it; without it the
  screenshots are broken on npmjs.com;
* `"author"`.

## 4. Accounts

* **npm:** an account at npmjs.com with two-factor authentication on (required for publishing). For publishing
  from CI with provenance, an automation or granular access token stored as a repository secret, or npm's
  trusted publishing with GitHub Actions.
* **VS Code Marketplace** (for the extension, step 2): a publisher at <https://marketplace.visualstudio.com/manage>
  (signs in with a Microsoft account), and an Azure DevOps personal access token with the *Marketplace (Manage)*
  scope for `vsce`.
* **Open VSX** (Cursor, Windsurf, VSCodium...): an Eclipse Foundation account, the Open VSX publisher agreement
  signed, an access token from <https://open-vsx.org/user-settings/tokens>, and the namespace created once with
  `npx ovsx create-namespace <publisher>`.

## 5. Versioning

Semantic versioning. The stable surface is the command line (options and exit codes), the `graph.json` format
and the `analyze()` API; changes there are breaking. While the version is `0.x`, a minor release may break.
Bump with `npm version patch|minor|major` (it tags the commit).

## 6. Release (npm)

1. `npm ci && npm run typecheck && npm test`.
2. If `tree-sitter` or `tree-sitter-typescript` was upgraded: run the **native-prebuilds** workflow, unpack its
   artifact into `native-prebuilds/` and commit it (`native-prebuilds/README.md`). `npm pack` refuses to
   package without them.
3. Push and wait for the **install-matrix** workflow (`.github/workflows/install-matrix.yml`) to pass on every
   platform: clean installs with npm and pnpm, the fixtures analyzed with the installed command, the same
   `graph.json` everywhere, and an offline run.
4. `npm pack --dry-run` and read the file list: `dist/`, `dist/native/`, `viewer/`, `README.md`,
   `package.json` (and `LICENSE`), nothing else. About 5.7 MB packed.
5. `npm publish` (add `--provenance` when publishing from GitHub Actions; scoped names also need
   `--access public`).
6. Check it the way a user would, in an empty directory: `npx <name> --version`, then on a real project.

## 7. Release (VS Code extension)

Filled in with step 2 (the extension): `vsce package` per platform, `vsce publish`, `ovsx publish`.
