# Changelog

All notable changes to SeamMap, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow the
[versioning policy](README.md#versioning).

Each release lists only the sections it needs, in this order: **Added**, **Changed**, **Deprecated**,
**Removed**, **Fixed**, **Security** (fixes to SeamMap itself), and **Results may differ**: every change in what
the analysis finds for unchanged code (edges, endpoints, protection states, findings, stats), so that anyone
comparing `graph.json` files across versions knows which differences come from the tool. Breaking changes start
with **Breaking:**.

## [Unreleased]

First public release.

### Added

- **Analysis** of a Laravel backend and a Next.js frontend (App and Pages Router) into one `graph.json`: files,
  classes, functions, methods and components; imports, calls and renders; Laravel routes and Next.js route
  handlers as endpoints, with the frontend's `fetch` and axios calls matched to them. Deterministic and offline:
  it reads the source and never runs either project.
- **Viewer** on `localhost`: Laravel, endpoint and Next.js lanes, focus and isolate, search by name, path or URL,
  orthogonal edge routing, open in VS Code, light and dark themes.
- **Security lens** (`--security`), a review aid and not a scanner: the protection state of each Laravel route,
  Next.js route handler and server action (middleware, policies, checks in code, `middleware.ts` matchers),
  import of SARIF results from your own scanners, and local pattern checks.
- **Command line:** monorepo detection, `--json-only`, `--list`, `seammap.config.json`, exit codes `0` and `1`.
- **Programmatic API:** `analyze()`, `findConfig()`, `loadConfig()`, `defaultConfig()`, `resolveRoots()`, `findProjects()`,
  `checkSchema()`, `VERSION`, `SCHEMA_VERSION`, and TypeScript types for `graph.json`.
- **Format version:** `graph.json` starts with `schemaVersion` (`1`), which changes only on incompatible format
  changes. The viewer explains files with another format version, or none, instead of drawing them.
- **Packaging:** prebuilt parsers for Linux, macOS and Windows on x64 and arm64 (and Alpine on x64), for
  Node.js 20 or newer; no install scripts, nothing to compile.
- **Config lookup that follows the projects:** without `--config`, the nearest `seammap.config.json` in or above
  the backend and frontend roots, up to the repository root, is used, wherever the command runs. When several are
  found, the one naming the analyzed projects wins. The summary always says which file was used and why, or
  where it looked; `findConfig()` exposes the rule.
- `meta.config` in `graph.json`: the config file used (relative to the backend root) and a hash of its settings,
  or `null`.
- **First step for the security lens:** when a few middleware (at most five) are all that keeps most unknown
  endpoints unknown, the summary, the Security tab and the "Start with" suggestion lead with them and a
  ready-to-edit snippet, with an exact count (`security.classifyFirst` in `graph.json`). States never change
  until you classify them.
- **First view of large maps:** fitted to the width of the lanes with readable group titles, and the suggested
  start scrolled into view and haloed, instead of the whole map at a few percent zoom.
- **VS Code extension** (`extension/`): **Open Map** analyzes the workspace in a background process with progress
  and cancel and shows the map in an editor tab; cards open their file at the right line beside it; the active
  editor's file is highlighted, and **Show Current File on Map** selects it; the status bar says when the map is
  out of date, and **Refresh Map** redoes it; the map follows the editor's theme. Settings for the backend,
  frontend, config file and security lens act like the CLI's options, and the config file is found by the same
  rule. One universal package for every platform and for remote development, Restricted Mode support (the
  workspace config's `security` section is then ignored), no network requests.
- The analyzer runs on either Tree-sitter runtime: the native bindings (the CLI) or WebAssembly (the extension),
  with identical results; the whole test suite runs on both. A WebAssembly runtime that runs out of memory stops
  the analysis with a message instead of skipping the rest of the project.
- `analyze()` takes an `onStage` callback for progress.

### Fixed

- Lane headers no longer clip their titles ("ENDPOIN") when lanes are narrow.
- Long middleware class names in the Security tab wrap instead of widening the panel.

### Results may differ

- The config lookup no longer depends on the current directory: the same command run from another folder now
  uses the config next to the projects, so states and links can differ from development builds that read
  `./seammap.config.json` only.
- Every `graph.json` gains `schemaVersion` as its first key, with or without `--security`, so files written by
  development builds differ from this release's even for the same code. The viewer asks to regenerate them.
