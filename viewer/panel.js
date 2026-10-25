// HTML for the side panel (Inspect / Insights / Security / Filters) and the hover tooltip.

import { icon } from './icons.js';
import { descendants, displayName, editorUrl, groupKey, iconOf, locationOf } from './model.js';
import { GROUPS, GROUP_ORDER, LANES, SEC_LABEL, SEC_STATES, laneOf, methodBadge, methodColor } from './theme.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt = (n) => (n ?? 0).toLocaleString('en-US');

/** Human label for what a node is. */
export function kindLabel(M, n) {
  if (!n) return '';
  if (n.kind === 'endpoint') return n.server === 'next' ? 'Next.js route handler' : 'Laravel route';
  if (n.kind === 'unmatched') return 'Unmatched HTTP call';
  const g = GROUPS[groupKey(M.byId.get(M.topOf.get(n.id)) ?? n)];
  if (n.kind === 'file') return `${n.side === 'backend' ? 'PHP' : 'JS/TS'} file · ${g?.label ?? ''}`;
  const kind = { method: 'Method', function: 'Function', class: 'Class', interface: 'Interface', trait: 'Trait', enum: 'Enum', closure: 'Route closure' }[n.kind] ?? n.kind;
  return `${kind} · ${g?.label ?? ''}`;
}

function colorOf(app, n) {
  const top = app.M.byId.get(app.M.topOf.get(n.id)) ?? n;
  return app.theme.groups[groupKey(top)] ?? app.theme.muted;
}

export function methodPill(app, method) {
  return `<span class="method" style="--m:${methodColor(app.theme, method)}">${esc(methodBadge(method))}</span>`;
}

/** One clickable row for a node (used everywhere in the panel). */
export function nodeRow(app, id, { sub, tag, line } = {}) {
  const { M } = app;
  const n = M.byId.get(id);
  if (!n) return '';
  const g = groupKey(M.byId.get(M.topOf.get(id)) ?? n);
  const isEp = n.kind === 'endpoint' || n.kind === 'unmatched';
  const title = isEp ? `${methodPill(app, n.method)}<span class="mono">${esc(n.path || n.name)}</span>` : esc(displayName(M, id));
  const where = sub ?? (line ? `${n.file ?? ''}:${line}` : locationOf(n));
  return `<button class="row" data-reveal="${esc(id)}" title="${esc(displayName(M, id))}">
    <span class="row-icon" style="--c:${colorOf(app, n)}">${icon(iconOf(n, GROUPS[g]?.icon), 14)}</span>
    <span class="row-main"><span class="row-title">${title}</span>${where ? `<span class="row-sub">${esc(where)}</span>` : ''}</span>
    ${tag ?? ''}
  </button>`;
}

const uncertainTag = '<span class="tag tag-uncertain" title="Not syntactically certain">uncertain</span>';

/** Unique neighbours over a list of raw edges (keeps the first edge for each). */
function neighbours(edges, pick) {
  const seen = new Map();
  for (const e of edges) {
    const other = pick(e);
    const prev = seen.get(other);
    if (!prev || (!prev.certain && e.certain)) seen.set(other, e);
  }
  return [...seen.entries()];
}

function section(title, rows, { open = true, count, empty } = {}) {
  if (!rows.length && !empty) return '';
  return `<details class="sec" ${open ? 'open' : ''}>
    <summary><span>${esc(title)}</span><span class="count">${count ?? rows.length}</span>${icon('arrowRight', 12, 'chev')}</summary>
    <div class="rows">${rows.length ? rows.join('') : `<p class="empty">${esc(empty)}</p>`}</div>
  </details>`;
}

function edgeRows(app, edges, pick, max = 60) {
  const list = neighbours(edges, pick);
  return list.slice(0, max).map(([id, e]) => nodeRow(app, id, { tag: e.certain ? '' : uncertainTag }));
}

// ---------------------------------------------------------------------------
// Inspect

/** Endpoints by number of distinct frontend callers, most first. */
function busiestEndpoints(M) {
  return M.graph.nodes
    .filter((n) => n.kind === 'endpoint')
    .map((n) => ({ n, callers: new Set((M.inc.get(n.id) || []).filter((e) => e.kind === 'http').map((e) => e.source)).size }))
    .sort((a, b) => b.callers - a.callers || (a.n.path || '').localeCompare(b.n.path || ''));
}

/** The security review order: most review flags first, then the weakest state. */
const SEC_ORDER = { none: 0, unknown: 1, public: 2, signed: 3, authenticated: 4, authorization: 5 };
function reviewSort(list) {
  return list.sort((a, b) => b.review.length - a.review.length || SEC_ORDER[a.state] - SEC_ORDER[b.state] || a.id.localeCompare(b.id));
}
const toReview = (e) => e.state === 'none' || e.state === 'unknown' || e.review.some((r) => r.startsWith('state-changing'));

/**
 * One place to start on a big map: the first item of the security review list (with the lens), else the
 * busiest endpoint, else the endpoint whose handler calls the most code.
 */
export function suggestedStart(app) {
  const { M } = app;
  const sec = M.graph.security;
  const top = sec ? reviewSort(sec.endpoints.filter(toReview))[0] : null;
  if (top) return { id: top.id, why: `First on the security review list: ${top.review[0] ?? SEC_LABEL[top.state].toLowerCase()}` };
  const busiest = busiestEndpoints(M)[0];
  if (busiest?.callers) return { id: busiest.n.id, why: `Busiest endpoint: ${busiest.callers} frontend caller${busiest.callers === 1 ? '' : 's'}` };
  let best = null;
  for (const n of M.graph.nodes) {
    if (n.kind !== 'endpoint') continue;
    const handler = (M.out.get(n.id) || []).find((e) => e.kind === 'handles')?.target;
    const calls = handler ? (M.out.get(handler) || []).filter((e) => e.kind === 'calls' || e.kind === 'renders').length : 0;
    if (calls && (!best || calls > best.calls)) best = { id: n.id, calls };
  }
  return best ? { id: best.id, why: `Most connected endpoint: its handler makes ${best.calls} call${best.calls === 1 ? '' : 's'}` } : null;
}

export function renderInspectEmpty(app) {
  const { M, meta } = app;
  const s = meta.stats;
  const endpoints = busiestEndpoints(M).slice(0, 7);
  const start = suggestedStart(app);
  const linked = s.httpCalls ? Math.round(((s.httpCalls - s.unmatchedHttpCalls) / s.httpCalls) * 100) : 0;
  const issues = s.unmatchedHttpCalls + s.unmatchedEndpoints;
  return `
    <div class="hero">
      <div class="eyebrow">${icon('sparkle', 13)} Start here</div>
      <h2>Trace a request across the stack</h2>
      <p>${
        meta.backendRoot && meta.frontendRoot
          ? 'Pick an endpoint to see which components call it and which Laravel code handles it.'
          : meta.backendRoot
            ? 'Pick a route to see the controller that handles it and everything that code calls.'
            : 'Pick an endpoint to see which components call it and what its handler does.'
      } Everything comes from parsing the source.</p>
    </div>
    ${
      start
        ? `<div class="card start-card">
        <div class="card-title">${icon('target', 13)} Start with</div>
        ${nodeRow(app, start.id, { sub: start.why })}
        <button class="btn primary" data-action="start" data-id="${esc(start.id)}">${icon('flow', 14)} Trace its chain</button>
      </div>`
        : ''
    }
    <div class="tiles tiles-3">
      ${tile('Files', fmt(s.files), `${fmt(M.graph.nodes.filter((n) => n.kind === 'file' && n.side === 'backend').length)} PHP · ${fmt(M.graph.nodes.filter((n) => n.kind === 'file' && n.side === 'frontend').length)} JS/TS`)}
      ${tile('Endpoints', fmt(s.endpoints), `${fmt(M.graph.nodes.filter((n) => n.kind === 'endpoint' && n.server === 'laravel').length)} Laravel · ${fmt(M.graph.nodes.filter((n) => n.kind === 'endpoint' && n.server === 'next').length)} Next`)}
      ${tile('Calls linked', s.httpCalls ? linked + '%' : '—', `${fmt(s.httpCalls - s.unmatchedHttpCalls)} of ${fmt(s.httpCalls)} HTTP calls`)}
    </div>
    ${
      endpoints.some((e) => e.callers)
        ? section('Busiest endpoints', endpoints.map(({ n, callers }) => nodeRow(app, n.id, { tag: `<span class="tag">${callers} caller${callers === 1 ? '' : 's'}</span>` })))
        : !meta.frontendRoot || !meta.backendRoot
          ? `<div class="card"><div class="card-title">Only the ${meta.backendRoot ? 'Laravel backend' : 'Next.js frontend'} was analyzed</div><p class="muted small" style="margin:0">Run with both <code>--backend</code> and <code>--frontend</code> to link HTTP calls to endpoints. You can still explore ${meta.backendRoot ? 'routes, controllers and their calls' : 'pages, components and their calls'}.</p></div>`
          : ''
    }
    ${
      issues
        ? `<div class="callouts">
        ${s.unmatchedHttpCalls ? `<button class="callout" data-goto-tab="insights">${icon('alert', 15)}<span><b>${s.unmatchedHttpCalls} HTTP call${s.unmatchedHttpCalls === 1 ? '' : 's'}</b> match no route</span>${icon('arrowRight', 13)}</button>` : ''}
        ${s.unmatchedEndpoints ? `<button class="callout" data-goto-tab="insights">${icon('endpoint', 15)}<span><b>${s.unmatchedEndpoints} endpoint${s.unmatchedEndpoints === 1 ? '' : 's'}</b> never called by the frontend</span>${icon('arrowRight', 13)}</button>` : ''}
      </div>`
        : ''
    }
    <div class="hints">
      <div><kbd>Click</kbd> focus a node and its chain</div>
      <div><kbd>Double-click</kbd> open a file into classes & methods</div>
      <div><kbd>Right-click</kbd> open in VS Code</div>
      <div><kbd>I</kbd> isolate · <kbd>/</kbd> search · <kbd>?</kbd> all shortcuts</div>
    </div>`;
}

function tile(label, value, sub, cls = '') {
  return `<div class="tile ${cls}"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ''}</div>`;
}

export function renderInspectNode(app, id) {
  const { M, meta, state } = app;
  const n = M.byId.get(id);
  if (!n) return renderInspectEmpty(app);
  const ids = n.kind === 'file' ? [id, ...descendants(M, id)] : [id];
  const own = new Set(ids);
  const incoming = ids.flatMap((x) => M.inc.get(x) || []).filter((e) => !own.has(e.source));
  const outgoing = ids.flatMap((x) => M.out.get(x) || []).filter((e) => !own.has(e.target));
  const k = (list, kinds) => list.filter((e) => kinds.includes(e.kind));
  const url = editorUrl(n, meta);
  const color = n.kind === 'endpoint' || n.kind === 'unmatched' ? methodColor(app.theme, n.method) : colorOf(app, n);
  const g = groupKey(M.byId.get(M.topOf.get(id)) ?? n);
  const chips = [
    n.role && n.side === 'backend' ? n.role : null,
    n.nextKind,
    n.client ? '"use client"' : null,
    n.component ? 'component' : null,
    n.visibility,
    n.static ? 'static' : null,
    n.route && n.kind === 'file' ? `route ${n.route}` : null,
    n.kind === 'endpoint' && meta.frontendRoot && !M.called.has(n.id) ? 'never called' : null,
    n.parseError ? 'syntax errors' : null,
  ].filter(Boolean);
  const canExpand = (M.children.get(id) || []).length > 0;
  const title = n.kind === 'endpoint' || n.kind === 'unmatched' ? n.path || n.name : displayName(M, id);

  const head = `
    <div class="inspect-head" style="--c:${color}">
      <div class="kind-chip">${icon(iconOf(n, GROUPS[g]?.icon), 13)} ${esc(kindLabel(M, n))}</div>
      <h2 class="title ${n.kind === 'endpoint' || n.kind === 'unmatched' ? 'mono' : ''}">${n.kind === 'endpoint' || n.kind === 'unmatched' ? methodPill(app, n.method) + ' ' : ''}${esc(title)}</h2>
      ${n.file ? `<div class="loc"><code>${esc(locationOf(n))}</code><button class="icon-btn sm" data-copy="${esc(locationOf(n))}" title="Copy path">${icon('copy', 13)}</button></div>` : ''}
      ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="actions">
      ${url ? `<a class="btn primary" href="${esc(url)}">${icon('external', 14)} Open in VS Code</a>` : ''}
      <button class="btn" data-action="isolate" aria-pressed="${state.isolated}">${icon('target', 14)} ${state.isolated ? 'Exit isolate' : 'Isolate'}</button>
      ${canExpand ? `<button class="btn" data-action="expand" data-id="${esc(id)}">${icon(state.expanded.has(id) ? 'collapse' : 'expand', 14)} ${state.expanded.has(id) ? 'Collapse' : 'Expand'}</button>` : ''}
      ${n.parent ? `<button class="btn ghost" data-reveal="${esc(M.topOf.get(id))}">${icon('file', 14)} File</button>` : ''}
    </div>`;

  // Endpoints: the request flow, callers -> endpoint -> handler -> what the handler calls.
  if (n.kind === 'endpoint') {
    const protection = app.sec?.get(id) ? renderProtection(app, app.sec.get(id)) : '';
    const reachable = app.findingsByEndpoint?.get(id) ?? [];
    const findings = reachable.length ? section('Findings reachable from here', sortFindings(app, reachable).slice(0, 40).map((f) => findingRow(app, f))) : '';
    const callers = edgeRows(app, k(incoming, ['http']), (e) => e.source);
    const handlers = k(outgoing, ['handles']);
    const handlerRows = edgeRows(app, handlers, (e) => e.target);
    const next = handlers.flatMap((h) => (M.out.get(h.target) || []).filter((e) => ['calls', 'renders', 'http'].includes(e.kind)));
    const nextRows = edgeRows(app, next, (e) => e.target, 12);
    return `${head}${protection}
      <div class="flow">
        <div class="flow-step"><div class="flow-label">Called by <span class="count">${callers.length}</span></div>${callers.join('') || '<p class="empty">No frontend call reaches this endpoint.</p>'}</div>
        <div class="flow-step flow-self"><div class="flow-label">Endpoint</div>
          <div class="flow-node" style="--c:${color}">${methodPill(app, n.method)}<span class="mono">${esc(n.path)}</span><span class="row-sub">${esc(locationOf(n))}</span></div></div>
        <div class="flow-step"><div class="flow-label">Handled by</div>${handlerRows.join('') || '<p class="empty">Handler not found.</p>'}</div>
        ${nextRows.length ? `<div class="flow-step"><div class="flow-label">Which calls</div>${nextRows.join('')}</div>` : ''}
      </div>
      ${findings}`;
  }

  // Unmatched calls: who makes them and why nothing matched.
  if (n.kind === 'unmatched') {
    const calls = M.graph.unmatched.httpCalls.filter((c) => c.target === id);
    return `${head}
      ${section(
        'Calls from',
        calls.map((c) => {
          const src = M.byId.get(c.source);
          const link = src ? editorUrl({ ...src, file: c.file, line: c.line }, meta) : null;
          return `<div class="issue">
            ${nodeRow(app, c.source, { sub: `${c.file}:${c.line}` })}
            <code class="expr">${esc(c.url)}</code>
            <div class="issue-foot"><span class="reason">${esc(c.reason)}</span>${link ? `<a href="${esc(link)}">${icon('external', 12)} open</a>` : ''}</div>
          </div>`;
        }),
      )}`;
  }

  // Browse a collapsed file's classes and functions without expanding it.
  const contents = canExpand && !state.expanded.has(id) && n.kind === 'file' ? descendants(M, id).slice(0, 40).map((c) => nodeRow(app, c)) : [];
  const here = app.findingsByNode ? ids.concat(n.kind === 'class' ? descendants(M, id) : []).flatMap((x) => app.findingsByNode.get(x) ?? []) : [];
  return `${head}
    ${app.sec?.get(id) ? renderProtection(app, app.sec.get(id)) : ''}
    ${here.length ? section('Findings', sortFindings(app, here).slice(0, 40).map((f) => findingRow(app, f, { here: true }))) : ''}
    <div class="stats-line">${icon('arrowRight', 12, 'flip')} ${fmt(incoming.length)} incoming · ${fmt(outgoing.length)} outgoing ${icon('arrowRight', 12)}</div>
    ${section('HTTP calls', edgeRows(app, k(outgoing, ['http']), (e) => e.target))}
    ${section('Handles endpoint', edgeRows(app, k(incoming, ['handles']), (e) => e.source))}
    ${section('Calls & renders', edgeRows(app, k(outgoing, ['calls', 'renders']), (e) => e.target))}
    ${section('Called & rendered by', edgeRows(app, k(incoming, ['calls', 'renders']), (e) => e.source))}
    ${section('Contents', contents, { open: false })}
    ${section('Imports & uses', edgeRows(app, k(outgoing, ['imports', 'uses']), (e) => e.target), { open: false })}
    ${section('Imported & used by', edgeRows(app, k(incoming, ['imports', 'uses']), (e) => e.source), { open: false })}`;
}

export function renderInspectEdge(app, a) {
  const { M, meta } = app;
  const rows = a.raw.map((e) => {
    const src = M.byId.get(e.source);
    const link = e.line && src ? editorUrl({ ...src, line: e.line }, meta) : null;
    return `<div class="occurrence">
      <div class="occ-path">${esc(displayName(M, e.source))} ${icon('arrowRight', 12)} ${esc(displayName(M, e.target))}</div>
      <div class="occ-meta">${esc(e.kind)}${e.via ? ' · ' + esc(e.via) : ''}${e.certain ? '' : ' · uncertain'}${e.count > 1 ? ' · ×' + e.count : ''}${link ? ` · <a href="${esc(link)}">line ${e.line}</a>` : ''}</div>
    </div>`;
  });
  return `
    <div class="inspect-head" style="--c:${app.theme.edges[a.kind]}">
      <div class="kind-chip">${icon('flow', 13)} ${esc(a.kind)} edge</div>
      <h2 class="title">${fmt(a.count)} ${a.count === 1 ? 'reference' : 'references'}</h2>
      <div class="chips"><span class="chip">${a.certain ? 'certain' : 'all uncertain'}</span></div>
    </div>
    <div class="flow compact">
      <div class="flow-step"><div class="flow-label">From</div>${nodeRow(app, a.s)}</div>
      <div class="flow-step"><div class="flow-label">To</div>${nodeRow(app, a.t)}</div>
    </div>
    ${section('Occurrences', rows)}`;
}

// ---------------------------------------------------------------------------
// Insights

export function renderInsights(app) {
  const { M, meta } = app;
  const s = meta.stats;
  const t = meta.timings;
  const http = M.graph.edges.filter((e) => e.kind === 'http');
  const certain = http.filter((e) => e.certain).length;
  const unmatched = http.filter((e) => e.via === 'unmatched').length;
  const uncertain = http.length - certain - unmatched;
  const pct = (x) => (http.length ? (x / http.length) * 100 : 0);
  const reasons = Object.entries(s.unresolvedByReason || {}).sort((a, b) => b[1] - a[1]);
  const maxReason = Math.max(1, ...reasons.map((r) => r[1]));
  const totalT = Math.max(1, t.scan + t.parse + t.extract + t.resolve + t.link);
  const stage = (name, v, c) => `<span style="width:${(v / totalT) * 100}%;background:${c}" title="${name} ${v} ms"></span>`;
  const unmatchedCalls = M.graph.unmatched.httpCalls.map((c) => {
    const src = M.byId.get(c.source);
    const link = src ? editorUrl({ ...src, file: c.file, line: c.line }, meta) : null;
    return `<div class="issue">
      ${nodeRow(app, c.target, { sub: `${c.file}:${c.line}` })}
      <code class="expr">${esc(c.url)}</code>
      <div class="issue-foot"><span class="reason">${esc(c.reason)}</span>${link ? `<a href="${esc(link)}">${icon('external', 12)} open</a>` : ''}</div>
    </div>`;
  });
  return `
    <div class="tiles">
      ${tile('Files', fmt(s.files), `${fmt(s.definitions)} definitions`)}
      ${tile('Endpoints', fmt(s.endpoints), s.unresolvedHandlers ? `${s.unresolvedHandlers} without handler` : 'all handlers found', s.unresolvedHandlers ? 'warn' : '')}
      ${tile('HTTP calls', fmt(s.httpCalls), `${fmt(s.unmatchedHttpCalls)} unmatched`, s.unmatchedHttpCalls ? 'warn' : '')}
      ${tile('Edges', fmt(s.edges), `${fmt(s.uncertainEdges)} uncertain`)}
      ${tile('Unresolved', fmt(s.unresolvedCalls), `calls · ${fmt(s.unresolvedImports)} imports`, s.unresolvedCalls ? 'warn' : '')}
      ${tile('Analysis', `${fmt(meta.durationMs)} ms`, `${fmt(s.parseErrors)} parse errors`)}
    </div>
    <div class="card">
      <div class="card-title">HTTP links <span class="muted">${fmt(http.length)}</span></div>
      <div class="bar">
        <span style="width:${pct(certain)}%;background:var(--ok)"></span>
        <span style="width:${pct(uncertain)}%;background:var(--accent)"></span>
        <span style="width:${pct(unmatched)}%;background:var(--danger)"></span>
      </div>
      <div class="bar-legend">
        <span><i style="background:var(--ok)"></i>certain ${fmt(certain)}</span>
        <span><i style="background:var(--accent)"></i>uncertain ${fmt(uncertain)}</span>
        <span><i style="background:var(--danger)"></i>unmatched ${fmt(unmatched)}</span>
      </div>
    </div>
    ${section('Unmatched HTTP calls', unmatchedCalls, { empty: 'Every detected HTTP call reaches an endpoint.' })}
    ${section('Endpoints never called', M.graph.unmatched.endpoints.map((eid) => nodeRow(app, eid)), { empty: meta.frontendRoot ? 'Every endpoint has a frontend caller.' : 'No frontend was analyzed, so callers are not known. Add --frontend to link them.' })}
    ${section(
      'Unresolved references',
      reasons.map(
        ([r, v]) => `<div class="reason-row"><span class="reason-name">${esc(r)}</span><span class="reason-bar"><span style="width:${(v / maxReason) * 100}%"></span></span><span class="reason-val">${fmt(v)}</span></div>`,
      ),
      { open: false, empty: 'Nothing unresolved.' },
    )}
    ${section('Warnings', (meta.warnings || []).map((w) => `<p class="note">${esc(w)}</p>`), { open: false, empty: 'No warnings.' })}
    ${section(
      'Diagnostics (sample)',
      (M.graph.diagnostics || []).slice(0, 300).map((d) => `<p class="note"><b>${esc(d.reason)}</b><br><span class="mono">${esc(d.file)}${d.line ? ':' + d.line : ''}</span> ${esc(d.text || '')}</p>`),
      { open: false, count: (M.graph.diagnostics || []).length, empty: 'None.' },
    )}
    <div class="card foot">
      <div class="card-title">Pipeline <span class="muted">${fmt(meta.durationMs)} ms</span></div>
      <div class="bar stages">${stage('scan', t.scan, '#8d94a7')}${stage('parse', t.parse, '#6f9dff')}${stage('extract', t.extract, '#b48cff')}${stage('resolve', t.resolve, '#4cd18a')}${stage('link', t.link, '#f2b54a')}</div>
      <div class="bar-legend"><span>scan ${t.scan}</span><span>parse ${t.parse}</span><span>extract ${t.extract}</span><span>resolve ${t.resolve}</span><span>link ${t.link}</span></div>
      <div class="roots"><div><span class="lane-dot be"></span><code>${esc(meta.backendRoot || '—')}</code></div><div><span class="lane-dot fe"></span><code>${esc(meta.frontendRoot || '—')}</code></div></div>
      <div class="muted small">Generated ${esc(new Date(meta.generatedAt).toLocaleString())}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Security lens

export const secPill = (app, state) => `<span class="sec-pill" style="--s:${app.theme.security[state]}">${esc(SEC_LABEL[state])}</span>`;

const EFFECT_ICON = { authorization: 'policy', authenticated: 'shield', authentication: 'shield', signed: 'lambda', public: 'page' };
const SOURCE_LABEL = {
  global: 'global',
  loader: 'route file group',
  group: 'route group',
  route: 'route',
  resource: 'resource route',
  controller: 'controller',
  'form-request': 'FormRequest',
  handler: 'handler code',
  'called-code': 'called code',
  middleware: 'middleware.ts',
};

/** Protection section of an endpoint or server action in Inspect. */
function renderProtection(app, ep) {
  const { meta } = app;
  const side = ep.id.startsWith('endpoint:laravel:') ? 'backend' : 'frontend';
  const signals = ep.signals.map((s) => {
    const link = s.file ? editorUrl({ side, file: s.file, line: s.line }, meta) : null;
    return `<div class="signal" style="--s:${app.theme.security[s.effect === 'authentication' ? 'authenticated' : s.effect] ?? app.theme.muted}">
      <span class="signal-icon">${icon(EFFECT_ICON[s.effect] ?? 'middleware', 13)}</span>
      <span class="signal-main"><span class="signal-text"><code>${esc(s.text)}</code> <span class="muted">${esc(SOURCE_LABEL[s.source] ?? s.source)} · ${esc(s.confidence)}</span></span>
      <span class="signal-detail">${esc(s.detail)}</span></span>
      ${link ? `<a class="signal-link" href="${esc(link)}" title="${esc(s.file)}:${s.line}">${icon('external', 12)}</a>` : ''}
    </div>`;
  });
  const notes = ep.notes.map((x) => `<p class="note">${esc(x)}</p>`);
  return `<div class="protection" style="--s:${app.theme.security[ep.state]}">
    <div class="protection-head">${secPill(app, ep.state)}<span class="muted small">${esc(ep.confidence)} confidence</span></div>
    <p class="protection-reason">${esc(ep.reason)}</p>
    ${ep.review.length ? `<div class="chips">${ep.review.map((r) => `<span class="chip chip-review">${icon('alert', 11)} ${esc(r)}</span>`).join('')}</div>` : ''}
    ${ep.middleware.length ? `<div class="mw-chain">${ep.middleware.map((m) => `<span class="mw">${esc(m)}</span>`).join('<span class="mw-sep">›</span>')}</div>` : ''}
    ${signals.length ? `<div class="signals">${signals.join('')}</div>` : ''}
    <div class="protection-foot">
      <span class="muted small">Reaches ${fmt(ep.reach)} definition${ep.reach === 1 ? '' : 's'} through known calls (a lower bound)</span>
      <button class="btn sm" data-action="reach" data-id="${esc(ep.id)}" title="Chain focus, isolated">${icon('flow', 13)} Show reach</button>
    </div>
    ${notes.length ? `<details class="sec sec-inline"><summary><span>Notes</span><span class="count">${notes.length}</span>${icon('arrowRight', 12, 'chev')}</summary><div class="rows">${notes.join('')}</div></details>` : ''}
  </div>`;
}

/** The Security tab: distribution, endpoints to review, what kept things unknown, and what is not checked. */
export function renderSecurity(app) {
  const { state, theme } = app;
  const sec = app.M.graph.security;
  if (!sec) return '<p class="empty">Run CodeMap with <code>--security</code> to add the security lens.</p>';
  const filter = state.secFilter;
  const barOf = (summary, n) =>
    SEC_STATES.map(([k]) => (summary[k] ? `<span style="width:${(summary[k] / (n || 1)) * 100}%;background:${theme.security[k]}" title="${esc(SEC_LABEL[k])}: ${summary[k]}"></span>` : '')).join('');
  const dot = (s) => `<span class="sec-dot" style="--s:${theme.security[s]}" title="${esc(SEC_LABEL[s])}"></span>`;
  const chips = SEC_STATES.map(
    ([k, label, help]) =>
      `<button class="sec-chip" data-sec-filter="${k}" aria-pressed="${filter === k}" title="${esc(help)}"><i style="background:${theme.security[k]}"></i>${esc(label)}<span class="count">${fmt(sec.summary[k])}</span></button>`,
  ).join('');
  // Default list: what a reviewer looks at first.
  const order = SEC_ORDER;
  const list = reviewSort(sec.endpoints.filter((e) => (filter ? e.state === filter : toReview(e))));
  const rows = list.slice(0, 150).map((e) => nodeRow(app, e.id, { sub: e.reason, tag: dot(e.state) }));
  const listTitle = filter ? SEC_LABEL[filter] : 'To review: no protection found, unknown, state-changing';
  // Server actions ('use server' exports): Next.js serves each one as a POST endpoint of its own.
  const actions = sec.actions ?? [];
  const actionList = actions
    .filter((e) => (filter ? e.state === filter : e.state === 'none' || e.state === 'unknown'))
    .sort((a, b) => order[a.state] - order[b.state] || b.frontendCallers - a.frontendCallers || a.id.localeCompare(b.id));
  const actionRows = actionList.slice(0, 150).map((e) => nodeRow(app, e.id, { sub: e.reason, tag: dot(e.state) }));
  const actionBlock = actions.length
    ? `<div class="card">
      <div class="card-title">Server actions <span class="muted">${fmt(actions.length)}</span></div>
      <div class="bar">${barOf(sec.actionSummary, actions.length)}</div>
      <p class="muted small">Exported functions of 'use server' files. Next.js serves each one as a POST endpoint that can be called directly, with any arguments, so they are read like endpoints.</p>
    </div>
    ${section(filter ? `Server actions: ${SEC_LABEL[filter]}` : 'Server actions to review: no protection found, unknown', actionRows, { count: actionList.length, empty: filter ? 'No server actions in this state.' : 'Nothing flagged for review.' })}
    ${actionList.length > actionRows.length ? `<p class="muted small">Showing ${actionRows.length} of ${fmt(actionList.length)}.</p>` : ''}`
    : '';
  const mw = sec.nextMiddleware;
  const runsOn = !mw ? '' : mw.matcher === null ? 'every path (no matcher)' : mw.matcher === 'unknown' ? 'a matcher CodeMap could not read' : mw.matcher.map((m) => `<code>${esc(m)}</code>`).join(' ');
  const mwBlock = mw
    ? section(
        mw.file,
        [
          `<p class="note mw-gate">Runs on ${runsOn}</p>`,
          ...(mw.conditional ?? []).map((c) => `<p class="note mw-gate">${icon('alert', 11)} Skippable: <code>${esc(c)}</code>. The client controls those headers or cookies, so gates under this entry are not counted.</p>`),
          ...(mw.ignored?.length ? [`<p class="note mw-gate">Not read by Next.js, and ignored here: ${mw.ignored.map((f) => `<code>${esc(f)}</code>`).join(', ')}</p>`] : []),
          ...mw.gates.map((g) => {
            const link = editorUrl({ side: 'frontend', file: g.file, line: g.line }, app.meta);
            // The path test is often part of the gate's own condition: say it once.
            const paths = !g.evaluated ? ' · path condition not evaluated' : g.text.includes(g.paths.replace(/^\(|\)$/g, '')) ? '' : ` · ${g.paths}`;
            return `<div class="issue mw-gate"><div class="mono small">${esc(g.text)}</div>
              <div class="issue-foot"><span class="reason">${esc(g.kind)} gate${esc(paths)}</span>${link ? `<a href="${esc(link)}">${icon('external', 12)} open</a>` : ''}</div></div>`;
          }),
          ...(mw.gates.length ? [] : ['<p class="note">No access gate found: nothing in it denies or redirects a request without a signed-in user or role.</p>']),
        ],
        { open: true, count: mw.gates.length },
      )
    : '';
  const unresolved = sec.middleware.unresolved.filter((u) => u.decisive > 0).slice(0, 12);
  const snippet = unresolved.length
    ? JSON.stringify({ security: { ignoreMiddleware: [], authMiddleware: [], authorizationMiddleware: [], publicMiddleware: [] } }, null, 2).replace('"ignoreMiddleware": []', `"ignoreMiddleware": [${unresolved.map((u) => `
      ${JSON.stringify(u.name)}`).join(',')}
    ]`)
    : '';
  return `
    <div class="hero sec-hero">
      <div class="eyebrow">${icon('shield', 13)} Security lens</div>
      <h2>Where to look</h2>
      <p>A review aid: what the code declares about access to each endpoint${actions.length ? ' and server action' : ''}. It shows where to look and certifies nothing. Every state links to the signals it is based on.</p>
      <label class="switch-row inline"><span class="switch-label">Colour cards by state</span><input type="checkbox" data-sec-lens ${state.secLens ? 'checked' : ''}><span class="switch"></span></label>
    </div>
    <div class="card">
      <div class="card-title">Endpoints <span class="muted">${fmt(sec.endpoints.length)}</span></div>
      <div class="bar">${barOf(sec.summary, sec.endpoints.length)}</div>
      <div class="sec-chips">${chips}</div>
    </div>
    ${section(listTitle, rows, { count: list.length, empty: filter ? 'No endpoints in this state.' : 'Nothing flagged for review.' })}
    ${list.length > rows.length ? `<p class="muted small">Showing ${rows.length} of ${fmt(list.length)}.</p>` : ''}
    ${actionBlock}
    ${mwBlock}
    ${section(
      'Why endpoints are unknown',
      sec.unknownReasons.map((r) => `<div class="reason-row"><span class="reason-name">${esc(r.label)}</span><span class="reason-val">${fmt(r.endpoints)}</span></div>`),
      { open: !!sec.summary.unknown, empty: 'No unknown endpoints.' },
    )}
    ${section(
      'Classify to resolve unknowns',
      unresolved.map(
        (u) => `<div class="issue"><div class="mono small">${esc(u.name)}</div>
          <div class="issue-foot"><span class="reason">${esc(u.reason)} · decides ${fmt(u.decisive)} of ${fmt(u.endpoints)} endpoints</span></div>
          ${u.hint ? `<p class="note">${esc(u.hint)}</p>` : ''}</div>`,
      ),
      { open: unresolved.length > 0, empty: 'Nothing to classify.' },
    )}
    ${snippet ? `<div class="card"><div class="card-title">codemap.config.json <button class="icon-btn sm" data-copy="${esc(snippet)}" title="Copy">${icon('copy', 13)}</button></div><p class="muted small">Move each entry to the list that matches what it does after reading it. The hints above are suggestions only.</p><pre class="snippet">${esc(snippet)}</pre></div>` : ''}
    ${renderFindingsBlock(app, sec)}
    ${section('Caveats', sec.caveats.map((c) => `<p class="note">${esc(c)}</p>`), { open: true, empty: 'None.' })}
    ${section('Not checked', sec.notChecked.map((c) => `<p class="note">${esc(c)}</p>`), { open: true })}`;
}

// ---------------------------------------------------------------------------
// Findings (imported SARIF results and CodeMap's local checks)

const LEVEL_ORDER = { error: 0, warning: 1, note: 2, none: 3 };
const STATE_ORDER = { none: 0, unknown: 1, public: 2, signed: 3, authenticated: 4, authorization: 5 };
const levelColor = (app, level) => (level === 'error' ? app.theme.security.none : level === 'warning' ? app.theme.security.unknown : app.theme.muted);

/** The least protected endpoint state among those that reach a finding. */
function weakestState(f) {
  let worst = null;
  for (const e of f.endpoints) if (e.state && (worst === null || STATE_ORDER[e.state] < STATE_ORDER[worst])) worst = e.state;
  return worst;
}

/** Reviewer order: suppressed last; reached from an endpoint first, then weakest protection, level, severity, location. */
export function sortFindings(app, list) {
  const key = (f) => [f.suppressed ? 1 : 0, f.endpointCount ? 0 : 1, STATE_ORDER[weakestState(f)] ?? 9, LEVEL_ORDER[f.level] ?? 9, -(f.severity ?? 0)];
  return [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.id.localeCompare(b.id);
  });
}

function findingRow(app, f, { here = false } = {}) {
  const loc = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : f.uri ?? 'no location';
  const link = f.file ? editorUrl({ side: f.side, file: f.file, line: f.line }, app.meta) : null;
  const worst = weakestState(f);
  const reach = f.endpointCount
    ? `reached from ${fmt(f.endpointCount)} endpoint${f.endpointCount === 1 ? '' : 's'}${worst ? ` · weakest: ${SEC_LABEL[worst]}` : ''}${f.endpoints.every((e) => e.via === 'class') ? ' (through its class)' : ''}`
    : f.entries.length
      ? `used by ${f.entries.length} page${f.entries.length === 1 ? '' : 's'} or route${f.entries.length === 1 ? '' : 's'}`
      : f.node
        ? 'no known path from an endpoint (the call graph is incomplete)'
        : `not on the map: ${f.outside}`;
  const who = f.origin === 'check' ? `CodeMap check · ${f.confidence} confidence` : f.tool;
  return `<div class="finding" style="--l:${levelColor(app, f.level)}">
    <div class="finding-head"><span class="level">${esc(f.level)}${f.severity !== undefined ? ' ' + f.severity.toFixed(1) : ''}</span>
      <span class="finding-rule" title="${esc(f.ruleId)}">${esc(f.title ?? f.ruleId)}</span>${f.suppressed ? '<span class="tag">suppressed</span>' : ''}</div>
    <div class="finding-msg">${esc(f.message)}</div>
    <div class="finding-foot"><span class="mono">${esc(loc)}</span><span class="muted">${esc(who)}</span>${link ? `<a href="${esc(link)}" title="Open in VS Code">${icon('external', 12)}</a>` : ''}</div>
    <div class="finding-reach">${worst ? `<span class="sec-dot" style="--s:${app.theme.security[worst]}"></span>` : ''}<span>${esc(reach)}</span>
      <span class="spacer"></span>
      ${f.node && !here ? `<button class="link-btn" data-reveal="${esc(f.node)}">show</button>` : ''}
      ${f.endpoints.length ? `<button class="link-btn" data-action="reach" data-id="${esc(f.endpoints[0].id)}" title="Chain focus from ${esc(f.endpoints[0].id.replace(/^endpoint:\w+:/, ''))}, isolated">path</button>` : ''}
    </div>
  </div>`;
}

/** Findings part of the Security tab. */
function renderFindingsBlock(app, sec) {
  const all = sec.findings ?? [];
  if (!all.length && !(sec.imports ?? []).length && !(sec.checks?.rules ?? []).length) return '';
  const which = app.state.secFindings ?? 'all';
  const placed = all.filter((f) => f.node);
  const shown = sortFindings(app, placed.filter((f) => which === 'all' || f.origin === which));
  const chip = (k, label, n) => `<button class="sec-chip" data-sec-findings="${k}" aria-pressed="${which === k}">${esc(label)}<span class="count">${fmt(n)}</span></button>`;
  const imports = (sec.imports ?? []).map(
    (i) => `<p class="note"><b>${esc(i.file.split('/').pop())}</b> · ${esc(i.tools.join(', ') || 'no runs')}<br>${fmt(i.results)} results · ${fmt(i.placed)} on the map · ${fmt(i.outside)} outside${i.suppressed ? ` · ${fmt(i.suppressed)} suppressed` : ''}${i.error ? `<br><span class="warn-text">${esc(i.error)}</span>` : ''}</p>`,
  );
  const rules = (sec.checks?.rules ?? []).map((r) => `<div class="reason-row" title="${esc(r.description)}"><span class="reason-name">${esc(r.title)}</span><span class="muted small">${esc(r.side)}</span><span class="reason-val">${fmt(r.hits)}</span></div>`);
  const skipped = (sec.checks?.skipped ?? []).map((s) => `<p class="note"><b>${esc(s.id)}</b>: not checked. ${esc(s.why)}</p>`);
  const outside = all.filter((f) => !f.node).map((f) => findingRow(app, f));
  return `
    <div class="card">
      <div class="card-title">Findings <span class="muted">${fmt(placed.length)} on the map</span></div>
      <p class="muted small" style="margin:0 0 8px">Imported from your scanners (SARIF) and CodeMap's few local checks, each placed on the definition that contains it, with the endpoints that reach it through known calls.</p>
      <div class="sec-chips">${chip('all', 'All', placed.length)}${chip('sarif', 'Imported', placed.filter((f) => f.origin === 'sarif').length)}${chip('check', 'CodeMap checks', placed.filter((f) => f.origin === 'check').length)}</div>
    </div>
    ${section('Findings', shown.slice(0, 150).map((f) => findingRow(app, f)), { count: shown.length, empty: 'No findings.' })}
    ${shown.length > 150 ? `<p class="muted small">Showing 150 of ${fmt(shown.length)}.</p>` : ''}
    ${outside.length ? section('Not on the map', outside.slice(0, 100), { open: false, count: outside.length }) : ''}
    ${imports.length ? section('Imported SARIF files', imports, { open: false }) : ''}
    ${rules.length ? section('CodeMap checks', [...rules, ...skipped], { open: false, count: rules.length }) : ''}`;
}

// ---------------------------------------------------------------------------
// Filters

export function renderFilters(app) {
  const { M, state, theme } = app;
  const kinds = [
    ['imports', 'Imports & use statements', (M.edgeCounts.imports || 0) + (M.edgeCounts.uses || 0)],
    ['calls', 'Calls (incl. new, static)', M.edgeCounts.calls || 0],
    ['renders', 'Renders (JSX)', M.edgeCounts.renders || 0],
    ['http', 'HTTP: frontend → endpoint', M.edgeCounts.http || 0],
    ['handles', 'Handles: endpoint → code', M.edgeCounts.handles || 0],
  ];
  const present = new Map();
  for (const id of M.top) {
    const g = groupKey(M.byId.get(id));
    present.set(g, (present.get(g) || 0) + 1);
  }
  const laneSection = (lane) => {
    const groups = GROUP_ORDER.filter((g) => laneOf(g) === lane && present.has(g));
    if (!groups.length) return '';
    return `<div class="filter-lane">
      <div class="filter-lane-head"><span class="lane-dot ${lane}"></span>${esc(LANES[lane].title)}
        <span class="spacer"></span><button class="link-btn" data-lane-all="${lane}">all</button><button class="link-btn" data-lane-none="${lane}">none</button></div>
      ${groups
        .map(
          (g) => `<label class="switch-row">
          <span class="row-icon" style="--c:${theme.groups[g]}">${icon(GROUPS[g].icon, 13)}</span>
          <span class="switch-label">${esc(GROUPS[g].label)}</span><span class="count">${present.get(g)}</span>
          <input type="checkbox" data-group="${g}" ${state.hiddenGroups.has(g) ? '' : 'checked'}><span class="switch"></span>
        </label>`,
        )
        .join('')}
    </div>`;
  };
  return `
    <div class="sec-static">
      <h3>Relationships</h3>
      ${kinds
        .map(
          ([k, label, count]) => `<label class="switch-row">
          <span class="line-swatch" style="--c:${theme.edges[k]}"></span>
          <span class="switch-label">${esc(label)}</span><span class="count">${fmt(count)}</span>
          <input type="checkbox" data-kind="${k}" ${state.kinds[k] ? 'checked' : ''}><span class="switch"></span>
        </label>`,
        )
        .join('')}
      <label class="switch-row">
        <span class="line-swatch dashed" style="--c:${theme.muted}"></span>
        <span class="switch-label">Uncertain edges</span><span class="count">${fmt(M.graph.edges.filter((e) => !e.certain).length)}</span>
        <input type="checkbox" data-uncertain ${state.uncertain ? 'checked' : ''}><span class="switch"></span>
      </label>
    </div>
    <div class="sec-static">
      <h3>Groups</h3>
      <p class="muted small">Hidden groups are removed from the layout.</p>
      ${laneSection('be')}${laneSection('ep')}${laneSection('fe')}
    </div>`;
}

// ---------------------------------------------------------------------------
// Tooltip

export function tooltipHtml(app, id) {
  const { M } = app;
  const n = M.byId.get(id);
  if (!n) return '';
  const g = groupKey(M.byId.get(M.topOf.get(id)) ?? n);
  // Files count the edges of their contents too (like the panel).
  const ids = n.kind === 'file' ? [id, ...descendants(M, id)] : [id];
  const own = new Set(ids);
  const ins = ids.flatMap((x) => M.inc.get(x) || []).filter((e) => !own.has(e.source)).length;
  const outs = ids.flatMap((x) => M.out.get(x) || []).filter((e) => !own.has(e.target)).length;
  const isEp = n.kind === 'endpoint' || n.kind === 'unmatched';
  const color = isEp ? methodColor(app.theme, n.method) : colorOf(app, n);
  return `
    <div class="tip-head"><span class="row-icon" style="--c:${color}">${icon(iconOf(n, GROUPS[g]?.icon), 13)}</span>
      <span class="tip-title ${isEp ? 'mono' : ''}">${isEp ? methodPill(app, n.method) + ' ' : ''}${esc(isEp ? n.path || n.name : displayName(M, id))}</span></div>
    <div class="tip-kind">${esc(kindLabel(M, n))}</div>
    ${n.file ? `<code class="tip-loc">${esc(locationOf(n))}</code>` : ''}
    ${app.sec?.get(id) ? `<div class="tip-sec">${secPill(app, app.sec.get(id).state)}<span>${esc(app.sec.get(id).reason)}</span></div>` : ''}
    ${app.findingCount?.(id) ? `<div class="tip-sec"><span class="sec-dot" style="--s:${app.theme.security.none}"></span><span>${app.findingCount(id)} finding${app.findingCount(id) === 1 ? '' : 's'}</span></div>` : ''}
    <div class="tip-foot"><span>${ins} in · ${outs} out</span><span>click focus · right-click open</span></div>`;
}
