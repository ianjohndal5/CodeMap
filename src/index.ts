// Programmatic API: the analysis the CLI runs, for scripts and integrations (a CI check, an editor
// extension). The CLI is the main way to use the tool; analyze() returns what it writes to graph.json.
import { analyze as run } from './analyze.js';
import { defaultConfig } from './config.js';
import type { CodemapConfig } from './config.js';
import type { Graph } from './types.js';

export interface ProjectOptions {
  /** Laravel project root, or null. */
  backend: string | null;
  /** Next.js project root, or null. */
  frontend: string | null;
  /** Settings as in the config file; defaults when omitted (see loadConfig). */
  config?: CodemapConfig;
  /** Collects warnings (they are also in graph.meta.warnings). */
  warnings?: string[];
  /** Add the security lens (`graph.security`), like --security. */
  security?: boolean;
}

/** Analyze a Laravel backend and/or a Next.js frontend. Deterministic, offline, and never runs either project. */
export function analyze(opts: ProjectOptions): { graph: Graph } {
  return { graph: run({ ...opts, config: opts.config ?? defaultConfig() }).graph };
}

export { VERSION } from './brand.js';
export { SCHEMA_VERSION, checkSchema } from './schema.js';
export type { SchemaProblem } from './schema.js';
export { defaultConfig, loadConfig } from './config.js';
export type { CodemapConfig, LaravelOptions, NextOptions, SecurityOptions } from './config.js';
export { findProjects, resolveRoots } from './detect.js';
export type { Diagnostic, EdgeKind, Graph, GraphEdge, GraphNode, NodeKind, Side, Stats, Timings, UnmatchedHttpCall } from './types.js';
export type * from './security/types.js';
