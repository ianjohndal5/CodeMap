import type { GraphBuilder } from './graph.js';
import type { Endpoint, HttpCall, Side } from './types.js';

export interface SideStats {
  files: number;
  definitions: number;
  parseErrors: number;
  unresolvedCalls: number;
  unresolvedByReason: Record<string, number>;
  unresolvedImports: number;
  /** Endpoints whose handler (controller method / closure) could not be found. */
  unresolvedHandlers: number;
}

export function emptyStats(): SideStats {
  return { files: 0, definitions: 0, parseErrors: 0, unresolvedCalls: 0, unresolvedByReason: {}, unresolvedImports: 0, unresolvedHandlers: 0 };
}

/**
 * A language adapter runs the shared pipeline stages for one project. All
 * framework-specific logic lives behind this interface (src/lang/php, src/lang/js).
 */
export interface Adapter {
  readonly side: Side;
  readonly root: string;
  scan(): void;
  parse(): void;
  extract(): void;
  /** Emit nodes and edges for this side; fill `endpoints` and `httpCalls` for the link stage. */
  resolve(graph: GraphBuilder): void;
  readonly endpoints: Endpoint[];
  readonly httpCalls: HttpCall[];
  readonly stats: SideStats;
  /** Human-readable definition listing ("file:line kind name"), for `--list`. */
  listDefinitions(): string[];
}

export function countReason(stats: SideStats, reason: string, countsAsUnresolved = true): void {
  stats.unresolvedByReason[reason] = (stats.unresolvedByReason[reason] ?? 0) + 1;
  if (countsAsUnresolved) stats.unresolvedCalls++;
}
