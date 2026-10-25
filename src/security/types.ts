// Output of the opt-in security lens (`--security`). A review aid: every state says
// what was seen and why; nothing here certifies an endpoint.

/**
 * Protection state of one endpoint, strongest first:
 * - authorization: an authorization check was seen (can: middleware, authorizeResource, FormRequest authorize(), $this->authorize(), Gate::authorize ...)
 * - authenticated: authentication middleware applies (auth, auth.basic, verified, ...)
 * - signed: a valid URL signature is required (signed middleware)
 * - public: explicitly meant for anonymous users (guest middleware)
 * - unknown: something that could change the answer was not resolved (custom or unresolved middleware, missing handler, ...)
 * - none: everything that applies was resolved and none of it restricts access
 */
export type ProtectionState = 'authorization' | 'authenticated' | 'signed' | 'public' | 'unknown' | 'none';
export const STATES: ProtectionState[] = ['authorization', 'authenticated', 'signed', 'public', 'unknown', 'none'];

export type Confidence = 'high' | 'medium' | 'low';

/** What one middleware or code check does to access, as far as CodeMap can tell. */
export type Effect = 'authorization' | 'authentication' | 'signed' | 'public' | 'unknown' | 'neutral';

export interface Signal {
  effect: Effect;
  /** Where it was found. */
  source: 'global' | 'loader' | 'group' | 'route' | 'resource' | 'controller' | 'form-request' | 'handler' | 'called-code' | 'middleware';
  /** As written: `auth:sanctum`, `$this->authorize('update', $post)`. */
  text: string;
  /** How it was resolved: `alias auth -> Illuminate\Auth\Middleware\Authenticate (framework default)`. */
  detail: string;
  confidence: Confidence;
  file?: string;
  line?: number;
}

/** An imported SARIF result or a CodeMap local check, placed on the graph. */
export interface Finding {
  /** Stable across runs: origin/tool/rule@file:line (+#n for repeats). */
  id: string;
  origin: 'sarif' | 'check';
  tool: string;
  ruleId: string;
  title?: string;
  level: 'error' | 'warning' | 'note' | 'none';
  /** SARIF security-severity (0-10), when the scanner provides it. */
  severity?: number;
  /** For CodeMap checks. */
  confidence?: Confidence;
  message: string;
  side: 'backend' | 'frontend' | null;
  file: string | null;
  line?: number;
  endLine?: number;
  /** Innermost definition containing the location (or its file). */
  node: string | null;
  /** Why the finding could not be placed on the map. */
  outside?: string;
  /** Location as written in the SARIF file, when it could not be placed. */
  uri?: string;
  suppressed?: boolean;
  /** SARIF file it came from. */
  source?: string;
  /** Endpoints that reach the node through known edges ('class': they use its class, not necessarily this method). */
  endpoints: { id: string; via: 'definition' | 'class'; distance: number; state?: ProtectionState }[];
  endpointCount: number;
  /** Frontend code calling those endpoints. */
  callers: string[];
  /** For frontend code: Next.js pages, layouts and route handlers that reach it. */
  entries: string[];
  /** One shortest known path: endpoint -> ... -> node. */
  path?: string[];
}

export interface EndpointSecurity {
  id: string;
  /** Set for Next.js server actions ('use server' functions); `id` is then the function's node id. */
  kind?: 'action';
  state: ProtectionState;
  confidence: Confidence;
  /** One line: why this state. */
  reason: string;
  /** Middleware that applies, as written (after withoutMiddleware), outermost first. */
  middleware: string[];
  signals: Signal[];
  /** Short codes for what kept the state at unknown (also counted in the summary). */
  unknown: string[];
  notes: string[];
  stateChanging: boolean;
  /** Frontend call sites linked to this endpoint (null when no frontend was analyzed). */
  frontendCallers: number | null;
  /** Definitions reachable from the handler through certain edges. A lower bound: the call graph is incomplete. */
  reach: number;
  /** Prompts for a human look ("state-changing, no protection found", "no frontend caller found"). */
  review: string[];
  /** Findings (SARIF or local checks) reachable from this endpoint through known edges. */
  findings: number;
}

export interface SecurityReport {
  version: 1;
  summary: Record<ProtectionState, number>;
  /** Why endpoints stayed unknown, most common first. One endpoint can have several reasons. */
  unknownReasons: { reason: string; label: string; endpoints: number }[];
  /**
   * The most useful first step when a few middleware (at most 5, from `middleware.unresolved`) are all that keeps
   * a majority of the unknown endpoints unknown: classifying them in the config gives those `endpoints` a state.
   * Null otherwise. Presentation only: states never change without the user's classification.
   */
  classifyFirst: { middleware: string[]; endpoints: number } | null;
  endpoints: EndpointSecurity[];
  middleware: {
    aliases: { name: string; target: string; source: string }[];
    groups: { name: string; members: string[]; source: string }[];
    global: { name: string; effect: Effect; detail: string }[];
    /** Middleware CodeMap could not classify, with how many endpoints it is decisive for. */
    unresolved: { name: string; reason: string; endpoints: number; decisive: number; hint?: string }[];
  };
  caveats: string[];
  /** Always shown in the UI: what this lens does not look at. */
  notChecked: string[];
  /** Imported SARIF results and local check hits, sorted by file and line. */
  findings: Finding[];
  /** One entry per SARIF file given. */
  imports: { file: string; tools: string[]; results: number; placed: number; outside: number; suppressed: number; error?: string }[];
  /** Next.js server actions, assessed like endpoints. */
  actions: EndpointSecurity[];
  actionSummary: Record<ProtectionState, number>;
  /** Next.js middleware.ts / proxy.ts: where it runs and which gates CodeMap could evaluate. */
  nextMiddleware: {
    file: string;
    matcher: string[] | null | 'unknown';
    /** Matcher entries with `has` / `missing` conditions: a request shaped by the client can skip them. */
    conditional: string[];
    /** Other middleware / proxy files, which Next.js does not read. */
    ignored: string[];
    gates: { kind: 'authentication' | 'authorization'; text: string; file: string; line: number; paths: string; evaluated: boolean }[];
  } | null;
  /** Local checks that ran (and the ones left out on purpose). */
  checks: { rules: { id: string; side: 'backend' | 'frontend'; title: string; description: string; hits: number }[]; skipped: { id: string; why: string }[] };
}
