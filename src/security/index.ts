import fs from 'node:fs';
import path from 'node:path';
import type { Adapter } from '../adapter.js';
import type { SecurityOptions } from '../config.js';
import { NextAdapter } from '../lang/js/index.js';
import { LaravelAdapter } from '../lang/php/index.js';
import type { SyntaxNode } from '../parse.js';
import type { Graph } from '../types.js';
import { ROUTE_PACKAGES } from './catalog.js';
import { CHECK_RULES, type CheckHit, jsChecks, phpChecks, SKIPPED_RULES } from './checks.js';
import { Placer, Reach } from './findings.js';
import type { PhpIndex } from './php.js';
import { decide, LaravelSecurity, type LaravelFindings } from './laravel.js';
import { strongest, UNKNOWN_LABELS } from './resolver.js';
import { analyzeNext, type NextFinding } from './next.js';
import { matchFile, readSarif } from './sarif.js';
import { STATES, type EndpointSecurity, type Finding, type ProtectionState, type SecurityReport, type Signal } from './types.js';

export type { SecurityReport } from './types.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REACH_CAP = 5000;

export const NOT_CHECKED = [
  'Nothing is executed and no requests are sent. States describe what the code declares; they do not certify an endpoint.',
  'Policies, gates and FormRequest authorize() bodies are not evaluated: a check that always allows looks like a strict one (except authorize() returning a literal true).',
  'Checks in handler code are reported when seen; whether every code path reaches them is not checked.',
  'Custom middleware is classified only through its extends chain, the built-in catalog or your security config; its body is not interpreted (hints only).',
  'Routes registered by packages (Sanctum, Fortify, Passport, Horizon, ...) are invisible to static parsing.',
  'Configuration is not read: CORS, Sanctum stateful domains, session and cookie settings, auth guards, and anything in .env.',
  'Next.js: route handlers and server actions are read for auth checks in their own code and in project helpers up to 3 calls deep, plus middleware.ts gates with literal path conditions. Supabase row-level security, NextAuth / Clerk configuration, and pages are not analyzed.',
  'Beyond the few local checks listed in the report, vulnerability classes (validation, injection, XSS, rate limits...) are not looked for. Imported SARIF findings are shown as the scanner reported them, not re-verified.',
  "Reach counts only known call edges. 'Not reachable' is never implied: a finding with no endpoint listed may still be reachable.",
];

/** Run the security lens over an analyzed graph. Read-only: the graph itself is not modified. */
export function analyzeSecurity(graph: Graph, adapters: Adapter[], options: SecurityOptions): SecurityReport {
  const laravel = adapters.find((a): a is LaravelAdapter => a instanceof LaravelAdapter) ?? null;
  const hasFrontend = adapters.some((a) => a.side === 'frontend');

  const calls = new Map<string, string[]>();
  const reachEdges = new Map<string, string[]>();
  const callers = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind === 'http') {
      let s = callers.get(e.target);
      if (!s) callers.set(e.target, (s = new Set()));
      s.add(e.source);
    }
    if (!e.certain || (e.kind !== 'calls' && e.kind !== 'handles')) continue;
    (reachEdges.get(e.source) ?? reachEdges.set(e.source, []).get(e.source)!).push(e.target);
    if (e.kind === 'calls') (calls.get(e.source) ?? calls.set(e.source, []).get(e.source)!).push(e.target);
  }
  const reach = (id: string): number => {
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length && seen.size <= REACH_CAP) for (const t of reachEdges.get(queue.shift()!) ?? []) if (!seen.has(t)) seen.add(t), queue.push(t);
    return seen.size - 1;
  };

  const lens = laravel ? new LaravelSecurity(laravel, options) : null;
  const findings = new Map<string, LaravelFindings>();
  for (const f of lens?.analyze((id) => calls.get(id) ?? []) ?? []) findings.set(f.endpointId, f);

  const nextAdapter = adapters.find((a): a is NextAdapter => a instanceof NextAdapter) ?? null;
  const nextResult = nextAdapter ? analyzeNext(nextAdapter, graph) : null;
  const fromNext = (base: Pick<EndpointSecurity, 'id' | 'stateChanging' | 'frontendCallers' | 'reach'>, f: NextFinding): EndpointSecurity => {
    const { state, confidence, lead } = decide(f.signals, f.unknown, 'medium');
    return {
      ...base,
      state,
      confidence,
      reason: lead
        ? `${lead.text} (${SOURCE_LABEL[lead.source]})`
        : state === 'unknown'
          ? 'not resolved: ' + uniq(f.unknown.map((u) => UNKNOWN_LABELS[u.reason] ?? u.reason)).slice(0, 2).join('; ')
          : 'no auth check found in the handler, the helpers it calls, or middleware',
      middleware: [],
      signals: f.signals,
      unknown: uniq(f.unknown.map((u) => u.reason)),
      notes: [...f.notes, ...f.unknown.map((u) => `unresolved: ${u.text}`)],
      review: [],
      findings: 0,
    };
  };
  const endpoints: EndpointSecurity[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'endpoint' || node.id.startsWith('unmatched:')) continue;
    const methods = (node.method ?? '').split('|');
    const base = {
      id: node.id,
      stateChanging: methods.some((m) => STATE_CHANGING.has(m) || m === 'ANY'),
      frontendCallers: hasFrontend ? (callers.get(node.id)?.size ?? 0) : null,
      reach: reach(node.id),
    };
    let ep: EndpointSecurity;
    const f = findings.get(node.id);
    const nf = nextResult?.endpoints.get(node.id);
    if (nf) {
      ep = fromNext(base, nf);
    } else if (f) {
      const { state, confidence, lead } = decide(f.signals, f.unknown, f.loader === 'convention' ? 'medium' : 'high');
      ep = {
        ...base,
        state,
        confidence,
        reason: reasonFor(state, lead, f),
        middleware: f.middleware,
        signals: f.signals,
        unknown: uniq(f.unknown.map((u) => u.reason)),
        notes: [...f.notes, ...f.unknown.map((u) => `unresolved: ${u.text}`)],
        review: [],
        findings: 0,
      };
    } else {
      ep = {
        ...base,
        state: 'unknown',
        confidence: 'low',
        reason: node.server === 'next' ? 'Next.js route handler: not analyzed' : 'not analyzed',
        middleware: [],
        signals: [],
        unknown: [node.server === 'next' ? 'next-handler' : 'handler-not-found'],
        notes: [],
        review: [],
        findings: 0,
      };
    }
    if (ep.stateChanging && ep.state === 'none') ep.review.push('state-changing, no protection found');
    if (ep.stateChanging && ep.state === 'unknown') ep.review.push('state-changing, protection not resolved');
    if (ep.frontendCallers === 0) ep.review.push('no frontend caller found');
    // /api/admin/users behind a login check only: any signed-in account gets in, unless something unseen checks the role.
    if (ep.state === 'authenticated' && /(^|\/)admin(\/|$)/i.test(node.path ?? '') && ep.signals.some((sg) => sg.effect === 'authentication' && !/shared secret/.test(sg.detail))) {
      ep.review.push('admin path, but no role or permission check was found');
    }
    endpoints.push(ep);
  }
  endpoints.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const summary = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<ProtectionState, number>;
  const reasons = new Map<string, number>();
  for (const ep of endpoints) {
    summary[ep.state]++;
    if (ep.state === 'unknown') for (const r of ep.unknown) reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }

  // Unresolved middleware: how many endpoints carry it, and for how many it is what keeps the state unknown.
  const unresolved = new Map<string, { name: string; reason: string; hint?: string; endpoints: Set<string>; decisive: Set<string> }>();
  const stateOf = new Map(endpoints.map((e) => [e.id, e.state]));
  for (const f of findings.values()) {
    const state = stateOf.get(f.endpointId);
    for (const u of f.unresolved) {
      let row = unresolved.get(u.name);
      if (!row) unresolved.set(u.name, (row = { name: u.name, reason: u.reason, hint: u.hint, endpoints: new Set(), decisive: new Set() }));
      row.endpoints.add(f.endpointId);
      if (state === 'unknown') row.decisive.add(f.endpointId);
    }
  }

  const unresolvedRows = [...unresolved.values()]
    .map((u) => ({ name: u.name, reason: u.reason, endpoints: u.endpoints.size, decisive: u.decisive.size, ...(u.hint ? { hint: u.hint } : {}) }))
    .sort((a, b) => b.decisive - a.decisive || b.endpoints - a.endpoints || (a.name < b.name ? -1 : 1));

  const caveats: string[] = [];
  const registry = lens?.registry;
  if (laravel) {
    for (const pkg of composerPackages(laravel.root)) if (ROUTE_PACKAGES[pkg]) caveats.push(`${pkg} is installed: ${ROUTE_PACKAGES[pkg]}; those routes are not listed.`);
    const convention = endpoints.filter((e) => findings.get(e.id)?.loader === 'convention').length;
    if (convention) caveats.push(`${convention} endpoint(s) come from route files whose loader was not found; the default web/api group is assumed (Laravel convention).`);
    if (registry && !registry.hasKernel && !laravel.bootstrap) caveats.push('Neither app/Http/Kernel.php nor bootstrap/app.php was found; framework default middleware groups are assumed.');
  }
  // Server actions: callers are the code that calls the action function.
  const callersOf = new Map<string, Set<string>>();
  for (const e of graph.edges) if (e.kind === 'calls') (callersOf.get(e.target) ?? callersOf.set(e.target, new Set()).get(e.target)!).add(e.source);
  const actions = (nextResult?.actions ?? []).map((f) => {
    const a = fromNext({ id: f.id, stateChanging: true, frontendCallers: callersOf.get(f.id)?.size ?? 0, reach: reach(f.id) }, f);
    a.kind = 'action';
    if (a.state === 'none') a.review.push('state-changing, no protection found');
    if (a.state === 'unknown') a.review.push('state-changing, protection not resolved');
    return a;
  });
  const actionSummary = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<ProtectionState, number>;
  for (const a of actions) actionSummary[a.state]++;
  if (nextResult) {
    const mwr = nextResult.middleware;
    if (mwr) {
      const where = mwr.matcher === null ? 'every path' : mwr.matcher === 'unknown' ? 'paths CodeMap could not read from config.matcher' : mwr.matcher.join(', ');
      caveats.push(`${mwr.file} runs on ${where}; ${mwr.gates.length} access gate(s) found, ${mwr.gates.filter((g) => !g.evaluated).length} with path conditions CodeMap could not evaluate.`);
      if (mwr.conditional.length) caveats.push(`${mwr.file} matcher entries with has/missing conditions can be skipped by a request that sends (or leaves out) those headers or cookies, so gates under them are not counted: ${mwr.conditional.join('; ')}.`);
      if (mwr.ignored.length) caveats.push(`${mwr.ignored.join(', ')} ${mwr.ignored.length === 1 ? 'is' : 'are'} not read by Next.js (it uses ${mwr.file}, next to the app directory); CodeMap ignores ${mwr.ignored.length === 1 ? 'it' : 'them'} too.`);
    }
    if (nextResult.inlineActions) caveats.push(`${nextResult.inlineActions} inline 'use server' function(s) inside other functions are not analyzed.`);
    caveats.push('Next.js states come from code that checks the session in handlers, server actions, their helpers and middleware. Supabase row-level security and other database-side rules are not read.');
  }

  // Findings: imported SARIF results and local checks, placed on the graph with their context.
  const next = adapters.find((a): a is NextAdapter => a instanceof NextAdapter) ?? null;
  const { list: placedFindings, imports } = collectFindings(graph, stateOf, options, {
    php: laravel && lens ? { files: treesOf(laravel.parsed), index: lens.index } : null,
    js: next ? treesOf(next.parsed) : null,
  });
  const byEndpoint = new Map<string, number>();
  for (const f of placedFindings) for (const e of f.endpoints) byEndpoint.set(e.id, (byEndpoint.get(e.id) ?? 0) + 1);
  for (const ep of endpoints) ep.findings = byEndpoint.get(ep.id) ?? 0;
  const hitsByRule = new Map<string, number>();
  for (const f of placedFindings) if (f.origin === 'check') hitsByRule.set(f.ruleId, (hitsByRule.get(f.ruleId) ?? 0) + 1);
  const enabledRules = options.checks ? CHECK_RULES.filter((r) => !options.disableChecks.includes(r.id)) : [];

  return {
    version: 1,
    summary,
    unknownReasons: [...reasons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([reason, n]) => ({ reason, label: UNKNOWN_LABELS[reason] ?? reason, endpoints: n })),
    endpoints,
    middleware: {
      aliases: registry ? [...registry.aliases].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, a]) => ({ name, target: a.target, source: a.source })) : [],
      groups: registry ? [...registry.groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, g]) => ({ name, members: g.members.map((m) => m.name ?? m.text), source: g.source })) : [],
      global: lens
        ? lens.globalLeaves().map(({ ref, leaves }) => ({ name: ref.name ?? ref.text, effect: strongest(leaves.map((l) => l.effect)), detail: leaves.map((l) => l.detail).join('; ') }))
        : [],
      unresolved: unresolvedRows,
    },
    classifyFirst: classifyFirst(unresolvedRows.map((u) => u.name), [...findings.values()].filter((f) => stateOf.get(f.endpointId) === 'unknown'), summary.unknown),
    caveats,
    notChecked: NOT_CHECKED,
    findings: placedFindings,
    imports,
    actions,
    actionSummary,
    nextMiddleware: nextResult?.middleware ?? null,
    checks: {
      rules: enabledRules.map((r) => ({ ...r, hits: hitsByRule.get(r.id) ?? 0 })),
      skipped: SKIPPED_RULES,
    },
  };
}

/**
 * The first few unresolved middleware (most decisive first) that are all that keeps a majority of the unknown
 * endpoints unknown: once each is listed in the config, every one of those endpoints gets a state. Of the first
 * five, the shortest run that settles at least 80% of what all five would (endpoints often carry several, so the
 * count can jump). Null when even five don't settle a majority. It ranks what to look at; it never changes a state.
 */
function classifyFirst(ranked: string[], unknownFindings: LaravelFindings[], unknown: number): SecurityReport['classifyFirst'] {
  // Endpoints whose every unknown entry goes away once its middleware is classified, with those names.
  const settleable = unknownFindings
    .filter((f) => f.unresolved.length && f.unknown.length === f.unresolved.filter((u) => u.settles).length)
    .map((f) => new Set(f.unresolved.map((u) => u.name)));
  const settled = ranked.slice(0, 5).map((_, i) => {
    const names = new Set(ranked.slice(0, i + 1));
    return settleable.filter((s) => [...s].every((n) => names.has(n))).length;
  });
  const most = settled.at(-1) ?? 0;
  if (most * 2 <= unknown) return null;
  const k = settled.findIndex((n) => n >= most * 0.8);
  return { middleware: ranked.slice(0, k + 1), endpoints: settled[k]! };
}

type Trees = Map<string, { root: SyntaxNode; source: string }>;

function treesOf(parsed: Map<string, { tree: { rootNode: SyntaxNode }; source: string }>): Trees {
  const out: Trees = new Map();
  for (const [rel, f] of parsed) out.set(rel, { root: f.tree.rootNode, source: f.source });
  return out;
}

const MESSAGE_MAX = 500;

/** Read SARIF files, run local checks, and place everything on the graph with endpoint context. */
function collectFindings(
  graph: Graph,
  states: Map<string, ProtectionState>,
  options: SecurityOptions,
  sources: { php: { files: Trees; index: PhpIndex } | null; js: Trees | null },
): { list: Finding[]; imports: SecurityReport['imports'] } {
  const placer = new Placer(graph);
  const reach = new Reach(graph, states);
  const roots = { backend: graph.meta.backendRoot, frontend: graph.meta.frontendRoot };
  const files = { backend: new Set<string>(), frontend: new Set<string>() };
  for (const n of graph.nodes) if (n.kind === 'file' && n.side && n.file) files[n.side].add(n.file);
  const context = (node: string | null) => (node ? reach.of(node) : { endpoints: [], endpointCount: 0, callers: [], entries: [] });
  const list: Omit<Finding, 'id'>[] = [];
  const imports: SecurityReport['imports'] = [];

  for (const file of [...new Set(options.sarif)]) {
    const sarif = readSarif(file);
    const row = { file, tools: sarif.tools, results: sarif.results.length, placed: 0, outside: 0, suppressed: 0, ...(sarif.error ? { error: sarif.error } : {}) };
    for (const r of sarif.results) {
      if (r.suppressed) row.suppressed++;
      const m = r.uri ? matchFile(r.uri, roots, files) : { reason: 'no location' };
      const common = {
        origin: 'sarif' as const,
        tool: r.tool,
        ruleId: r.ruleId,
        ...(r.ruleName ? { title: r.ruleName } : {}),
        level: r.level,
        ...(r.severity !== undefined ? { severity: r.severity } : {}),
        message: r.message.length > MESSAGE_MAX ? r.message.slice(0, MESSAGE_MAX - 1) + '…' : r.message,
        ...(r.line !== undefined ? { line: r.line } : {}),
        ...(r.endLine !== undefined ? { endLine: r.endLine } : {}),
        ...(r.suppressed ? { suppressed: true } : {}),
        source: file,
      };
      if ('side' in m) {
        row.placed++;
        const node = placer.place(m.side, m.rel, r.line);
        list.push({ ...common, side: m.side, file: m.rel, node, ...context(node) });
      } else {
        row.outside++;
        list.push({ ...common, side: null, file: null, node: null, outside: m.reason, ...(r.uri ? { uri: r.uri } : {}), ...context(null) });
      }
    }
    imports.push(row);
  }

  if (options.checks) {
    const hits: CheckHit[] = [...(sources.php ? phpChecks(sources.php.files, sources.php.index) : []), ...(sources.js ? jsChecks(sources.js) : [])].filter(
      (h) => !options.disableChecks.includes(h.ruleId),
    );
    const titles = new Map(CHECK_RULES.map((r) => [r.id, r.title]));
    for (const h of hits) {
      const node = placer.place(h.side, h.file, h.line);
      list.push({
        origin: 'check',
        tool: 'codemap',
        ruleId: h.ruleId,
        title: titles.get(h.ruleId),
        level: 'warning',
        confidence: h.confidence,
        message: h.message,
        side: h.side,
        file: h.file,
        line: h.line,
        endLine: h.endLine,
        node,
        ...context(node),
      });
    }
  }

  const key = (f: Omit<Finding, 'id'>) => [f.file ?? '~' + (f.uri ?? ''), String(f.line ?? 0).padStart(8, '0'), f.origin, f.tool, f.ruleId, f.message].join('\u0000');
  list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const used = new Map<string, number>();
  const out = list.map((f) => {
    const base = `${f.origin}/${f.tool}/${f.ruleId}@${f.file ?? f.uri ?? '?'}:${f.line ?? 0}`;
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return { id: n ? `${base}#${n + 1}` : base, ...f };
  });
  return { list: out, imports };
}


const SOURCE_LABEL: Record<Signal['source'], string> = {
  global: 'global middleware',
  loader: 'route file group',
  group: 'route group',
  route: 'route',
  resource: 'resource route',
  controller: 'controller middleware',
  'form-request': 'FormRequest',
  handler: 'handler code',
  'called-code': 'called code',
  middleware: 'middleware.ts',
};

function reasonFor(state: ProtectionState, lead: Signal | null, f: LaravelFindings): string {
  if (lead) {
    // For a group, say what inside it decided: "api (route file group): Authenticate: requires a signed-in user".
    const inner = lead.detail.startsWith('group ') ? lead.detail.split(' -> ').pop() : null;
    return `${lead.text} (${SOURCE_LABEL[lead.source]})${inner ? `: ${inner}` : ''}`;
  }
  if (state === 'unknown') return 'not resolved: ' + uniq(f.unknown.map((u) => UNKNOWN_LABELS[u.reason] ?? u.reason)).slice(0, 2).join('; ');
  return f.loader === 'convention' ? 'all middleware resolved (loader assumed); none restricts access' : 'all middleware resolved; none restricts access';
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function composerPackages(root: string): string[] {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8').replace(/^\uFEFF/, '')) as { require?: Record<string, string> };
    return Object.keys(json.require ?? {}).sort();
  } catch {
    return [];
  }
}
