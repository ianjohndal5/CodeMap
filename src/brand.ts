import { createRequire } from 'node:module';

// The product's name lives in package.json: "name" (npm), "bin" (the command) and "displayName" (shown in
// the CLI and the viewer). Everything else derives from them; scripts/rename.mjs changes all of it at once.
const pkg = createRequire(import.meta.url)('../package.json') as { version: string; displayName?: string; bin?: Record<string, string> };

export const VERSION = pkg.version;
export const DISPLAY_NAME = pkg.displayName ?? 'CodeMap';
export const COMMAND = Object.keys(pkg.bin ?? {})[0] ?? 'codemap';
/** Looked up in the working directory when no --config is given. */
export const CONFIG_FILE = `${COMMAND}.config.json`;
/** Default output directory for graph.json. */
export const OUT_DIR = `.${COMMAND}`;
