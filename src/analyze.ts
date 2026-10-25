import path from 'node:path';
import type { Adapter } from './adapter.js';
import { GraphBuilder } from './graph.js';
import { NextAdapter } from './lang/js/index.js';
import { LaravelAdapter } from './lang/php/index.js';
import { link } from './link.js';
import { SCHEMA_VERSION } from './schema.js';
import { analyzeSecurity } from './security/index.js';
import type { AnalyzeOptions, Graph, Stats, Timings } from './types.js';
import { toPosix } from './util/paths.js';
import { VERSION } from './brand.js';

export { VERSION };
export type { AnalyzeOptions };

export interface AnalyzeResult {
  graph: Graph;
  adapters: Adapter[];
}

type Stage = Exclude<keyof Timings, 'security'>;

function timed(timings: Timings, stage: Stage, fn: () => void): void {
  const t0 = performance.now();
  fn();
  timings[stage] += performance.now() - t0;
}

/** Run the whole pipeline (scan -> parse -> extract -> resolve -> link) without any UI. */
export function analyze(opts: AnalyzeOptions): AnalyzeResult {
  const started = performance.now();
  const warnings = opts.warnings ?? [];
  const config = opts.config;
  const timings: Timings = { scan: 0, parse: 0, extract: 0, resolve: 0, link: 0 };
  const graph = new GraphBuilder({ ranges: Boolean(opts.security) });

  // When one project lives inside the other (monorepo), keep their files apart.
  if (opts.backend && opts.frontend) {
    const inner = path.relative(opts.frontend, opts.backend);
    if (inner && !inner.startsWith('..') && !path.isAbsolute(inner)) config.next.exclude.push(`${toPosix(inner)}/**`);
    const inner2 = path.relative(opts.backend, opts.frontend);
    if (inner2 && !inner2.startsWith('..') && !path.isAbsolute(inner2)) config.laravel.exclude.push(`${toPosix(inner2)}/**`);
  }

  const adapters: Adapter[] = [];
  const keepSyntax = Boolean(opts.security);
  if (opts.backend) adapters.push(new LaravelAdapter(opts.backend, config, warnings, { keepSyntax }));
  if (opts.frontend) adapters.push(new NextAdapter(opts.frontend, config, warnings, { keepSyntax }));

  for (const a of adapters) timed(timings, 'scan', () => a.scan());
  for (const a of adapters) timed(timings, 'parse', () => a.parse());
  for (const a of adapters) timed(timings, 'extract', () => a.extract());
  for (const a of adapters) timed(timings, 'resolve', () => a.resolve(graph));

  const endpoints = adapters.flatMap((a) => a.endpoints);
  const httpCalls = adapters.flatMap((a) => a.httpCalls);
  let linked = { matchedCalls: 0, unmatchedCalls: [] as Graph['unmatched']['httpCalls'], unmatchedEndpoints: [] as string[] };
  timed(timings, 'link', () => {
    linked = link(graph, httpCalls, endpoints, {
      backendEnvVars: config.next.backendEnvVars,
      backendHosts: config.next.backendHosts,
      ...(config.next.backendBasePath !== undefined ? { backendBasePath: config.next.backendBasePath } : {}),
    }, { backend: Boolean(opts.backend), frontend: Boolean(opts.frontend) });
  });

  const { nodes, edges } = graph.sorted();
  const unresolvedByReason: Record<string, number> = {};
  for (const a of adapters) {
    for (const [k, v] of Object.entries(a.stats.unresolvedByReason)) {
      const key = `${a.side}:${k}`;
      unresolvedByReason[key] = (unresolvedByReason[key] ?? 0) + v;
    }
  }
  const sum = (f: (a: Adapter) => number) => adapters.reduce((n, a) => n + f(a), 0);
  const stats: Stats = {
    files: sum((a) => a.stats.files),
    definitions: sum((a) => a.stats.definitions),
    edges: edges.length,
    endpoints: endpoints.length,
    unresolvedCalls: sum((a) => a.stats.unresolvedCalls),
    unmatchedHttpCalls: linked.unmatchedCalls.length,
    unmatchedEndpoints: linked.unmatchedEndpoints.length,
    parseErrors: sum((a) => a.stats.parseErrors),
    httpCalls: httpCalls.length,
    uncertainEdges: edges.filter((e) => !e.certain).length,
    unresolvedImports: sum((a) => a.stats.unresolvedImports),
    unresolvedHandlers: sum((a) => a.stats.unresolvedHandlers),
    unresolvedByReason: Object.fromEntries(Object.entries(unresolvedByReason).sort()),
  };
  for (const k of Object.keys(timings) as Stage[]) timings[k] = Math.round(timings[k]);
  if (graph.diagnosticsDropped) warnings.push(`${graph.diagnosticsDropped} more diagnostics were not recorded (at most 250 per reason).`);

  const result: Graph = {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      tool: 'codemap',
      version: VERSION,
      backendRoot: opts.backend ? toPosix(opts.backend) : null,
      frontendRoot: opts.frontend ? toPosix(opts.frontend) : null,
      generatedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      timings,
      stats,
      warnings,
    },
    nodes,
    edges,
    unmatched: { endpoints: linked.unmatchedEndpoints, httpCalls: linked.unmatchedCalls },
    diagnostics: graph.diagnostics,
  };
  if (opts.security) {
    const t0 = performance.now();
    result.security = analyzeSecurity(result, adapters, config.security);
    timings.security = Math.round(performance.now() - t0);
    result.meta.durationMs = Math.round(performance.now() - started);
  }
  return { graph: result, adapters };
}
