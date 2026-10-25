# SeamMap for VS Code

See how a **Laravel** backend and a **Next.js** frontend connect, inside the editor: which components call which
endpoint, which controller handles it, and what that code calls in turn. Click a card and the file opens at the
right line beside the map.

SeamMap reads the source code. It never runs your projects, never needs a database or a server, and never sends
anything anywhere.

## Getting started

1. Open a folder that contains a Laravel project, a Next.js project, or both (a monorepo, or one of the two).
2. Run **SeamMap: Open Map** from the Command Palette.
3. The analysis runs in the background with progress in a notification (large projects take 10 to 20 seconds),
   then the map opens in an editor tab.

On the map: click a card to focus it and its neighbours, **Isolate** (`I`) to lay out only that chain, `/` to
search by name, path or a URL like `/api/users/42`, and double-click a function, method or endpoint (or use
**Open file** in the side panel) to open it beside the map. `?` lists every shortcut.

## Commands

| Command | What it does |
| --- | --- |
| **SeamMap: Open Map** | Analyzes the workspace folder and shows the map (or brings the open map to the front). |
| **SeamMap: Refresh Map** | Analyzes again. The status bar says *SeamMap: out of date* when files changed since the map was made; click it to refresh. |
| **SeamMap: Show Current File on Map** | Selects the active editor's file on the map. The file you are editing is also highlighted on the map as you switch editors. |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `seammap.backend` | (empty) | Laravel project root, relative to the workspace folder. |
| `seammap.frontend` | (empty) | Next.js project root, relative to the workspace folder. |
| `seammap.configFile` | (empty) | A `seammap.config.json` to use, relative to the workspace folder. |
| `seammap.security` | `false` | Add the security lens: route protection signals for review. |

The extension finds projects and configuration exactly like the `seammap` command line does when you run it on
the workspace folder: the settings act like its `--backend`, `--frontend`, `--config` and `--security` options,
so **settings win over `seammap.config.json`, which wins over automatic detection**. Without `seammap.configFile`,
the nearest `seammap.config.json` in or above the projects is used (up to the repository root). The **SeamMap**
output channel says which projects and which config file each analysis used.

In a multi-root workspace, SeamMap maps one folder at a time and asks which one.

## Security lens

With `seammap.security` on, endpoints and Next.js server actions are outlined by what the code declares about
access (authorization check seen, authenticated, signed URL, public, unknown, no protection found), with the
signals each state is based on. It is a **review aid, not a scanner**: it shows where to look and certifies
nothing. When a few custom middleware keep most endpoints unknown, the Security tab starts with them and a
ready-to-edit config snippet. SeamMap never classifies middleware by its name; only your config does.

## Restricted Mode

SeamMap works in untrusted workspaces (Restricted Mode), which is useful for reviewing unfamiliar code: it only
reads files. In Restricted Mode it ignores the **`security` section** of the workspace's `seammap.config.json`
(middleware classifications and SARIF imports), because an untrusted config could make unprotected routes look
protected, and the `seammap.configFile` setting. Trust the workspace to apply them.

## Privacy

* **Offline.** The extension makes no network requests: no telemetry, no update checks, no downloads. The map is
  drawn from files packaged with the extension, under a content security policy that allows no remote content.
* **Nothing is executed.** Your projects are parsed, never run. No PHP, Node.js or project scripts are started, and
  `.env` files are never read.
* **Local files only.** The analysis result (`graph.json`) is kept in VS Code's storage for the workspace and is
  not shared.

## Remote development

The extension runs where your files are (WSL, SSH, Dev Containers, Codespaces) and needs nothing installed there:
its parsers are WebAssembly, so the same package works on every platform and architecture.

## Limits

* The parsers have a fixed memory ceiling (2 GiB of WebAssembly memory). A project of about 5,500 files uses about
  0.8 GiB, so very large codebases (around 14,000 files and up) can exceed it; SeamMap then stops with a message
  rather than show a partial map. The `seammap` command line has no such limit.
* What SeamMap extracts and matches, and its deliberate limitations, are described in the project README.

## Third-party software

The extension bundles Cytoscape.js and cytoscape-elk (MIT), ELK (EPL-2.0), the IBM Plex and Space Grotesk fonts
(SIL OFL 1.1), web-tree-sitter and the Tree-sitter grammars (MIT), and the analyzer's dependencies; see
`THIRD_PARTY_NOTICES.md`.
