# Changelog

All notable changes to CodeMap, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow the
[versioning policy](README.md#versioning).

Each release lists only the sections it needs, in this order: **Added**, **Changed**, **Deprecated**,
**Removed**, **Fixed**, **Security** (fixes to CodeMap itself), and **Results may differ**: every change in what
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
- **Command line:** monorepo detection, `--json-only`, `--list`, `codemap.config.json`, exit codes `0` and `1`.
- **Programmatic API:** `analyze()`, `loadConfig()`, `defaultConfig()`, `resolveRoots()`, `findProjects()`,
  `checkSchema()`, `VERSION`, `SCHEMA_VERSION`, and TypeScript types for `graph.json`.
- **Format version:** `graph.json` starts with `schemaVersion` (`1`), which changes only on incompatible format
  changes. The viewer explains files with another format version, or none, instead of drawing them.
- **Packaging:** prebuilt parsers for Linux, macOS and Windows on x64 and arm64, for Node.js 20 or newer; no
  install scripts, nothing to compile.

### Results may differ

- Every `graph.json` gains `schemaVersion` as its first key, with or without `--security`, so files written by
  development builds differ from this release's even for the same code. The viewer asks to regenerate them.
