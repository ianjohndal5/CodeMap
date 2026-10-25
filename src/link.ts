import type { GraphBuilder } from './graph.js';
import { matchCall, type PatternedEndpoint } from './match/match.js';
import { laravelPattern, nextPattern, normalizeCallUrl, type NormalizeOptions } from './match/url.js';
import type { Endpoint, HttpCall, UnmatchedHttpCall } from './types.js';

export interface LinkResult {
  matchedCalls: number;
  unmatchedCalls: UnmatchedHttpCall[];
  unmatchedEndpoints: string[];
}

const DYNAMIC_ID = 'unmatched:dynamic';

/**
 * Link stage: normalize every frontend HTTP call, match it against Laravel and
 * Next.js endpoints, and emit `http` edges. Calls that match nothing point at an
 * "unmatched" pseudo-endpoint so they stay visible in the middle column.
 */
/** Which sides were analyzed: without a backend nothing can match it, without a frontend nothing calls the endpoints. */
export interface Sides {
  backend: boolean;
  frontend: boolean;
}

export function link(graph: GraphBuilder, calls: HttpCall[], endpoints: Endpoint[], opts: NormalizeOptions, sides: Sides = { backend: true, frontend: true }): LinkResult {
  const laravel: PatternedEndpoint[] = [];
  const next: PatternedEndpoint[] = [];
  for (const ep of endpoints) {
    if (ep.server === 'laravel') laravel.push({ ...ep, segs: laravelPattern(ep.path) });
    else next.push({ ...ep, segs: nextPattern(ep.path) });
  }
  const called = new Set<string>();
  const unmatchedCalls: UnmatchedHttpCall[] = [];
  let matchedCalls = 0;
  // An env var has one value at runtime: a base path inferred from a fallback anywhere applies to all its uses.
  const inferred = new Map<string, Set<string>>();
  for (const call of calls) {
    for (const part of call.url) {
      if (part.t !== 'env' || part.basePath === undefined) continue;
      if (!inferred.has(part.name)) inferred.set(part.name, new Set());
      inferred.get(part.name)!.add(part.basePath);
    }
  }
  const agreed = new Map([...inferred].filter(([, paths]) => paths.size === 1).map(([name, paths]) => [name, [...paths][0]]));
  if (agreed.size) opts = { ...opts, inferredBasePaths: agreed };

  const sorted = [...calls].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  for (const call of sorted) {
    const method = call.method ?? '?';
    const norm = normalizeCallUrl(call.url, opts);
    const found = norm ? matchCall(norm, call.method, laravel, next) : null;
    const result = found?.ambiguous ? null : found;
    if (result) {
      matchedCalls++;
      for (const ep of result.endpoints) {
        called.add(ep.id);
        graph.addEdge({ source: call.source, target: ep.id, kind: 'http', certain: result.certain, line: call.line, ...(result.via ? { via: result.via } : {}) });
      }
      continue;
    }
    let target: string;
    let reason: string;
    if (!norm) {
      target = DYNAMIC_ID;
      reason = 'dynamic URL';
      graph.addNode({ id: target, kind: 'unmatched', name: '(dynamic URL)', method: '?', path: '(dynamic)' });
    } else {
      target = `unmatched:${method} ${norm.display}`;
      reason = found?.ambiguous
        ? `ambiguous: ${found.endpoints.length} endpoints match`
        : norm.target === 'backend'
          ? sides.backend
            ? 'no Laravel route matches'
            : 'calls the backend, which was not analyzed (no --backend)'
          : norm.target === 'relative'
            ? sides.backend
              ? 'no Next.js route handler or Laravel route matches'
              : 'no Next.js route handler matches (no backend was analyzed)'
            : norm.target === 'external'
              ? 'external URL'
              : 'unknown base URL and no suffix match';
      graph.addNode({ id: target, kind: 'unmatched', name: `${method} ${norm.display}`, method, path: norm.display });
    }
    graph.addEdge({ source: call.source, target, kind: 'http', certain: false, line: call.line, via: 'unmatched' });
    unmatchedCalls.push({ target, source: call.source, file: call.file, line: call.line, method, url: call.raw, reason });
  }
  const unmatchedEndpoints = sides.frontend ? endpoints.filter((e) => !called.has(e.id)).map((e) => e.id).sort() : [];
  return { matchedCalls, unmatchedCalls, unmatchedEndpoints };
}
