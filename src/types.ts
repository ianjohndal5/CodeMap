import type { CodemapConfig } from './config.js';
import type { SecurityReport } from './security/types.js';

// Shared graph format (graph.json) and pipeline types.

export type Side = 'backend' | 'frontend';

export interface AnalyzeOptions {
  /** Laravel project root, or null. */
  backend: string | null;
  /** Next.js project root, or null. */
  frontend: string | null;
  config: CodemapConfig;
  /** Collects warnings (also written to graph.meta.warnings). */
  warnings?: string[];
  /** Run the security lens and add `security` to the graph. */
  security?: boolean;
  /** Called as each stage starts (for progress: the editor extension shows it). */
  onStage?: (stage: keyof Timings) => void;
}

export type NodeKind =
  | 'file'
  | 'class'
  | 'interface'
  | 'trait'
  | 'enum'
  | 'method'
  | 'function'
  | 'closure'
  | 'endpoint'
  | 'unmatched';

export type EdgeKind = 'imports' | 'uses' | 'calls' | 'renders' | 'http' | 'handles';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  side?: Side;
  name?: string;
  /** Path relative to the project root of `side` (or of the endpoint's server). */
  file?: string;
  line?: number;
  /** Last line of a definition. Only emitted with --security (SARIF findings are attached by range). */
  endLine?: number;
  parent?: string;
  /** Backend role from the file path (controller, model, ...). */
  role?: string;
  /** Next.js file convention (page, layout, route, ...). */
  nextKind?: string;
  /** Next.js URL path derived from the file location. */
  route?: string;
  client?: boolean;
  /** JS function that renders JSX. */
  component?: boolean;
  visibility?: string;
  static?: boolean;
  /** File parsed with syntax errors (results are best-effort). */
  parseError?: boolean;
  // Endpoint fields
  server?: 'laravel' | 'next';
  method?: string;
  path?: string;
  pattern?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  certain: boolean;
  line?: number;
  /** Number of merged occurrences (same source, target, kind, certainty). */
  count?: number;
  /** Sub-kind, e.g. 'new', 'static', 'extends', 'jsx', 'relative', 'suffix'. */
  via?: string;
}

export interface UnmatchedHttpCall {
  /** Node id of the unmatched pseudo-endpoint in the middle column. */
  target: string;
  source: string;
  file: string;
  line: number;
  method: string;
  url: string;
  reason: string;
}

export interface Diagnostic {
  side: Side;
  file: string;
  line?: number;
  text?: string;
  reason: string;
}

export interface Stats {
  files: number;
  definitions: number;
  edges: number;
  endpoints: number;
  unresolvedCalls: number;
  unmatchedHttpCalls: number;
  unmatchedEndpoints: number;
  parseErrors: number;
  httpCalls: number;
  uncertainEdges: number;
  unresolvedImports: number;
  unresolvedHandlers: number;
  unresolvedByReason: Record<string, number>;
}

export interface Timings {
  scan: number;
  parse: number;
  extract: number;
  resolve: number;
  link: number;
  /** Only with --security. */
  security?: number;
}

export interface Graph {
  /** Format version (SCHEMA_VERSION in schema.ts); the first key of graph.json. */
  schemaVersion: number;
  meta: {
    tool: string;
    version: string;
    backendRoot: string | null;
    frontendRoot: string | null;
    /**
     * The config file used, or null for the defaults. `path` is relative to the backend root (the frontend root
     * without a backend), with / separators; `sha256` hashes its parsed settings, so comments, formatting and
     * line endings don't change it.
     */
    config: { path: string; sha256: string } | null;
    generatedAt: string;
    durationMs: number;
    timings: Timings;
    stats: Stats;
    warnings: string[];
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  unmatched: {
    endpoints: string[];
    httpCalls: UnmatchedHttpCall[];
  };
  /** Sample of things that could not be resolved (capped), for debugging. */
  diagnostics: Diagnostic[];
  /** Security lens (only with --security). */
  security?: SecurityReport;
}

// ---------------------------------------------------------------------------
// Link stage: HTTP calls and endpoints exchanged between the language adapters.

/** One piece of a URL expression, before or after constant resolution. */
export type UrlPart =
  | { t: 'lit'; v: string }
  /**
   * process.env.X / import.meta.env.X. `basePath`: the path of a literal fallback
   * (`process.env.X || "http://localhost:8000/api"` -> "/api"), read from code, never from .env.
   */
  | { t: 'env'; name: string; basePath?: string }
  /** Identifier not yet resolved (local const, import, or configured base variable). */
  | { t: 'ident'; name: string }
  /** `obj.prop` where obj may be a const object of URL strings. */
  | { t: 'member'; object: string; prop: string }
  /** A configured base-URL variable that could not be resolved further. */
  | { t: 'base'; name: string }
  /** Anything dynamic. */
  | { t: 'expr'; text: string };

export interface HttpCall {
  /** Graph node id of the enclosing function/component (or file). */
  source: string;
  file: string;
  line: number;
  /** Upper-case HTTP method, or null when it cannot be determined. */
  method: string | null;
  /** URL parts after constant resolution; base URL of an axios instance already prepended. */
  url: UrlPart[];
  /** True when the URL came through an axios instance whose baseURL is env/absolute. */
  viaBackendInstance: boolean;
  raw: string;
}

export interface Endpoint {
  id: string;
  server: 'laravel' | 'next';
  methods: string[];
  /** Display path, e.g. /api/users/{user} or /api/users/[id]. */
  path: string;
  file: string;
  line: number;
  /** Graph node id of the handler (method, closure, function, or file). */
  handler: string | null;
  handlerCertain: boolean;
}
