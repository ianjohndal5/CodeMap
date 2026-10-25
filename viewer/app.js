/* global cytoscape, cytoscapeElk, ELK */
// SeamMap viewer: reads graph.json (written by the analyzer) and renders it with
// Cytoscape.js + the ELK layered layout. No build step, no framework.

import { cardTab, icon, methodTab } from './icons.js';
import { stylesheet } from './graphstyle.js';
import { Minimap } from './minimap.js';
import { buildModel, descendants, displayName, editorUrl, groupKey, iconOf, labelOf, search, sizeOf } from './model.js';
import { esc, methodPill, renderFilters, renderInsights, renderInspectEdge, renderInspectEmpty, renderInspectNode, renderSecurity, suggestedStart, tooltipHtml } from './panel.js';
import { computeRoutes, routeStyle } from './route.js';
import { checkSchema } from './schema.js'; // served from dist/schema.js (src/schema.ts), shared with the API
import { editorTheme, graphUrl, inWebview, onEditorTheme, onHostMessage, openLink, postToHost, store, testMode } from './host.js';
import { BAND, GROUPS, GROUP_ORDER, LANES, THEMES, laneOf, methodBadge, methodColor } from './theme.js';

// Below these sizes the real cards are laid out with ELK layered ("flow"); above
// them ELK lays out role groups and cards are packed inside each group.
const FLOW_LIMIT = { nodes: 350, edges: 1500 };
/** Edge kinds followed by "chain" focus: behaviour, not structure (imports/uses are left out). */
const CHAIN_KINDS = new Set(['calls', 'renders', 'http', 'handles']);
/** Which toggle controls each edge kind. */
const TOGGLE_OF = { imports: 'imports', uses: 'imports', calls: 'calls', renders: 'renders', http: 'http', handles: 'handles' };
const EDGE_TOGGLES = [
  ['imports', 'imports'],
  ['calls', 'calls'],
  ['renders', 'renders'],
  ['http', 'http'],
  ['handles', 'handles'],
];
const SEC_CLASSES = ['sec-authorization', 'sec-authenticated', 'sec-signed', 'sec-public', 'sec-unknown', 'sec-none'];
/** Extra space between the three lanes (ELK spaces partitions like ordinary layers). */
const LANE_GUTTER = 44;
/** Initial zoom floor for small (flow) graphs: below it labels stop being readable. */
const READABLE_ZOOM = 0.68;
/** Below this zoom a whole-map fit shows nothing readable: large maps open fitted to the lanes' width instead. */
const OVERVIEW_BELOW = 0.25;
/** Screen space kept free around a fitted graph (lane headers on top, docks below). */
const FIT_PAD = { top: 64, bottom: 72, x: 36 };

const $ = (sel) => document.querySelector(sel);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Theme-dependent visuals of a node: accent colour and the left tab image (none for large graphs). */
function nodeVisual(n, top, theme, large = false) {
  const g = groupKey(top);
  const accent = theme.groups[g] ?? theme.muted;
  if (large) return { accent, icon: 'none' };
  const [, h] = sizeOf(n);
  if (n.kind === 'endpoint' || n.kind === 'unmatched') {
    return { accent, icon: methodTab(methodBadge(n.method), methodColor(theme, n.method), h, n.kind === 'unmatched') };
  }
  return { accent, icon: cardTab(iconOf(n, GROUPS[g]?.icon), accent, h, Boolean(n.client)) };
}

/** Cytoscape edge elements for aggregated edges (width grows with the number of merged edges). */
function edgeElements(edges) {
  return edges.map((e) => {
    const width = Math.min(1.4 + Math.log2(e.count) * 0.8, 5);
    return {
      group: 'edges',
      data: { id: e.id, source: e.s, target: e.t, kind: e.kind, width, hlwidth: width + 1.6, count: e.count },
      classes: e.certain ? e.kind : e.kind + ' uncertain',
    };
  });
}

/** Transitive callers ('in') or callees ('out') of `seeds` along behavioural edges (CHAIN_KINDS). */
function chain(seeds, dir) {
  let acc = seeds.cy().collection();
  let frontier = seeds;
  while (frontier.nonempty()) {
    const edges = (dir === 'out' ? frontier.outgoers('edge') : frontier.incomers('edge')).filter((e) => CHAIN_KINDS.has(e.data('kind'))).difference(acc);
    const reached = (dir === 'out' ? edges.targets() : edges.sources()).difference(acc).difference(seeds);
    acc = acc.union(edges).union(reached);
    // Continue from expanded files' contents too, so a chain can pass through an expanded file.
    frontier = reached.union(reached.descendants());
  }
  return acc;
}

function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

class App {
  constructor(graph, themeName) {
    this.M = buildModel(graph);
    this.meta = graph.meta;
    this.theme = THEMES[themeName];
    this.state = {
      expanded: new Set(),
      kinds: { imports: true, calls: true, renders: true, http: true, handles: true },
      uncertain: true,
      depth: 'auto',
      layout: 'auto',
      hiddenGroups: new Set(),
      selected: null,
      selectedEdge: null,
      isolated: false,
      tab: 'inspect',
      // Security lens (graph.json from --security): outline endpoint cards by protection state.
      secLens: false,
      secFilter: null,
    };
    // Endpoints and server actions by node id.
    this.sec = graph.security ? new Map([...graph.security.endpoints, ...(graph.security.actions ?? [])].map((e) => [e.id, e])) : null;
    // Findings by the node that contains them, and by the endpoints that reach them.
    this.findingsByNode = new Map();
    this.findingsByEndpoint = new Map();
    this.findingSubtree = new Map();
    for (const f of graph.security?.findings ?? []) {
      if (!f.node) continue;
      if (!this.findingsByNode.has(f.node)) this.findingsByNode.set(f.node, []);
      this.findingsByNode.get(f.node).push(f);
      for (const e of f.endpoints) {
        if (!this.findingsByEndpoint.has(e.id)) this.findingsByEndpoint.set(e.id, []);
        this.findingsByEndpoint.get(e.id).push(f);
      }
      for (let id = f.node; id; id = this.M.byId.get(id)?.parent) this.findingSubtree.set(id, (this.findingSubtree.get(id) ?? 0) + 1);
    }
    this.state.secLens = Boolean(this.sec) && store.get('seammap.secLens') !== 'off';
    this.large = this.M.top.length > FLOW_LIMIT.nodes;
    this.cy = cytoscape({
      container: $('#cy'),
      style: stylesheet(this.theme, { large: this.large }),
      minZoom: 0.02,
      maxZoom: 3,
      boxSelectionEnabled: false,
      hideEdgesOnViewport: this.large,
      textureOnViewport: this.large,
      motionBlur: false,
    });
    this.minimap = new Minimap(this.cy, $('#minimap'), this.theme);
    // The minimap earns its space on large graphs; small ones fit on screen anyway.
    const mapPref = store.get('seammap.minimap');
    this.setMinimap(mapPref ? mapPref === 'on' : this.large, false);
    this.laneBoxes = {};
    this.edgeData = new Map();
    this.lastLayout = { mode: '', ms: 0 };
    this.initChrome();
    this.bind();
    this.renderPanel();
  }

  // --- chrome -----------------------------------------------------------------

  initChrome() {
    const base = (p) => (p ? p.replace(/\/$/, '').split('/').pop() : null);
    const be = base(this.meta.backendRoot);
    const fe = base(this.meta.frontendRoot);
    $('#project-chip').textContent = [be, fe].filter(Boolean).join('  ⇄  ');
    $('#project-chip').title = [this.meta.backendRoot, this.meta.frontendRoot].filter(Boolean).join('\n');
    // Lane headers (positions follow the viewport, see updateOverlays).
    const heads = $('#lane-heads');
    heads.innerHTML = ['be', 'ep', 'fe']
      .map((l) => `<div class="lane-head" data-lane="${l}" style="--lane:var(--${l === 'be' ? 'laravel' : l === 'ep' ? 'endpoint' : 'next'})" hidden><span class="dot"></span><b>${LANES[l].title}</b><span></span></div>`)
      .join('');
    this.laneHeads = Object.fromEntries([...heads.children].map((el) => [el.dataset.lane, el]));
    this.renderLegendBar();
    this.updateBadges();
    this.updateThemeButton();
    if (this.sec) {
      $('[data-tab="security"]').hidden = false;
      $('#btn-sec').hidden = false;
      $('#btn-sec').setAttribute('aria-pressed', String(this.state.secLens));
      $('#help-sec').hidden = false;
      const { summary: s, actionSummary: a } = this.M.graph.security;
      const none = s.none + (a?.none ?? 0);
      const unknown = s.unknown + (a?.unknown ?? 0);
      const badge = $('#security-badge');
      badge.textContent = none + unknown;
      badge.hidden = !(none + unknown);
      badge.title = `${none} no protection found · ${unknown} unknown${a ? ' (endpoints and server actions)' : ''}`;
    }
  }

  /** Findings on this node, or inside it when it is shown collapsed. */
  findingCount(id) {
    const expanded = this.state.expanded.has(id) && (this.M.children.get(id) || []).length;
    return expanded ? (this.findingsByNode.get(id)?.length ?? 0) : (this.findingSubtree.get(id) ?? 0);
  }

  hasFindingMark(id) {
    return this.findingSubtree.size > 0 && this.findingCount(id) > 0;
  }

  /** Toggle the endpoint outlines and finding marks (class changes only). */
  setSecLens(on) {
    if (!this.sec) return;
    this.state.secLens = on;
    store.set('seammap.secLens', on ? 'on' : 'off');
    this.cy.batch(() => {
      this.cy.nodes().forEach((n) => {
        for (const c of SEC_CLASSES) n.removeClass(c);
        const e = on ? this.sec.get(n.id()) : null;
        if (e) n.addClass('sec-' + e.state);
      });
      this.cy.nodes('.has-finding').removeClass('has-finding');
      // Block body on purpose: Cytoscape's forEach stops when the callback returns false.
      if (on && this.findingSubtree.size) {
        this.cy.nodes().forEach((n) => {
          if (this.hasFindingMark(n.id())) n.addClass('has-finding');
        });
      }
    });
    $('#btn-sec').setAttribute('aria-pressed', String(on));
    if (this.state.tab === 'security') this.renderPanel();
  }

  /** Chain focus on an endpoint, isolated: what it reaches through known edges (and who calls it). */
  async showReach(id) {
    this.state.depth = 'chain';
    for (const b of document.querySelectorAll('.seg[data-seg="depth"] button')) b.setAttribute('aria-pressed', String(b.dataset.value === 'chain'));
    await this.reveal(id);
    if (!this.state.isolated) await this.isolate(true);
  }

  renderLegendBar() {
    const { M, state, theme } = this;
    const count = (k) => (k === 'imports' ? (M.edgeCounts.imports || 0) + (M.edgeCounts.uses || 0) : M.edgeCounts[k] || 0);
    $('#legend-bar').innerHTML =
      EDGE_TOGGLES.map(
        ([k, label]) =>
          `<button class="legend-chip" data-kind="${k}" aria-pressed="${state.kinds[k]}" title="Show / hide ${label} edges"><span class="line-swatch" style="--c:${theme.edges[k]}"></span>${label}<span class="count">${count(k)}</span></button>`,
      ).join('') +
      `<button class="legend-chip" data-uncertain aria-pressed="${state.uncertain}" title="Show / hide uncertain edges"><span class="line-swatch dashed" style="--c:${theme.muted}"></span>uncertain<span class="count">${M.graph.edges.filter((e) => !e.certain).length}</span></button>`;
  }

  updateBadges() {
    const s = this.meta.stats;
    const issues = s.unmatchedHttpCalls + s.unmatchedEndpoints;
    const ib = $('#insights-badge');
    ib.hidden = !issues;
    ib.textContent = issues;
    const hidden = this.state.hiddenGroups.size + Object.values(this.state.kinds).filter((v) => !v).length + (this.state.uncertain ? 0 : 1);
    const fb = $('#filters-badge');
    fb.hidden = !hidden;
    fb.textContent = hidden;
  }

  updateThemeButton() {
    $('#btn-theme').innerHTML = icon(this.theme.name === 'dark' ? 'sun' : 'moon');
  }

  /** `remember`: false when following the editor's theme (VS Code decides, nothing to store). */
  applyTheme(name, remember = true) {
    this.theme = THEMES[name];
    document.documentElement.dataset.theme = name;
    if (remember) store.set('seammap.theme', name);
    this.cy.style(stylesheet(this.theme, { large: this.large }));
    this.cy.batch(() => {
      this.cy.nodes().forEach((n) => {
        if (n.hasClass('lane')) n.data('accent', this.theme.lanes[n.data('lane')]);
        else if (n.hasClass('group')) n.data('accent', this.theme.groups[n.data('group')]);
        else {
          const m = this.M.byId.get(n.id());
          if (m) n.data(nodeVisual(m, this.M.byId.get(this.M.topOf.get(m.id)), this.theme, this.large));
        }
      });
    });
    this.minimap.setTheme(this.theme);
    this.updateThemeButton();
    this.renderLegendBar();
    this.renderPanel();
  }

  // --- view computation ---------------------------------------------------------

  /** Visible node ids: top-level nodes not hidden by group filters, plus contents of expanded files. */
  visibleSet() {
    const { M, state } = this;
    const visible = new Set();
    for (const id of M.top) {
      if (state.hiddenGroups.has(groupKey(M.byId.get(id)))) continue;
      visible.add(id);
      if (state.expanded.has(id)) for (const d of descendants(M, id)) visible.add(d);
    }
    return visible;
  }

  /** Aggregate raw edges onto visible representatives (collapsed files absorb their contents). */
  aggregateEdges(visible, onlyKinds = null) {
    const { M, state } = this;
    const repCache = new Map();
    const rep = (id) => {
      if (repCache.has(id)) return repCache.get(id);
      let cur = id;
      while (cur && !visible.has(cur)) cur = M.byId.get(cur)?.parent;
      repCache.set(id, cur || null);
      return cur || null;
    };
    const agg = new Map();
    for (const e of M.graph.edges) {
      if (onlyKinds && !onlyKinds.has(e.kind)) continue;
      if (!state.kinds[TOGGLE_OF[e.kind]]) continue;
      if (!e.certain && !state.uncertain) continue;
      const s = rep(e.source);
      const t = rep(e.target);
      if (!s || !t || s === t) continue;
      const key = s + '\u0001' + t + '\u0001' + e.kind;
      let a = agg.get(key);
      if (!a) agg.set(key, (a = { id: 'e:' + key, s, t, kind: e.kind, count: 0, certain: false, raw: [] }));
      a.count += e.count || 1;
      a.certain = a.certain || e.certain;
      if (a.raw.length < 25) a.raw.push(e);
    }
    return [...agg.values()];
  }

  chooseMode(visibleCount, edgeCount) {
    if (this.state.layout !== 'auto') return this.state.layout;
    return visibleCount <= FLOW_LIMIT.nodes && edgeCount <= FLOW_LIMIT.edges ? 'flow' : 'grouped';
  }

  buildElements(visible, edges, mode) {
    const { M, state, theme } = this;
    const els = [];
    const groupsUsed = new Map();
    for (const id of visible) {
      const n = M.byId.get(id);
      const top = M.byId.get(M.topOf.get(id));
      const isTop = top.id === id;
      const g = groupKey(top);
      const [w, h, tab] = sizeOf(n);
      const classes = [n.kind === 'file' ? 'file' : n.kind === 'endpoint' || n.kind === 'unmatched' ? n.kind : 'def'];
      if (n.kind === 'endpoint' && n.server === 'laravel' && this.meta.frontendRoot && !M.called.has(n.id)) classes.push('uncalled');
      if (state.secLens && this.sec?.has(id)) classes.push('sec-' + this.sec.get(id).state);
      if (state.secLens && this.hasFindingMark(id)) classes.push('has-finding');
      if (n.parseError) classes.push('parse-error');
      if (isTop) classes.push('top');
      if (state.expanded.has(id) && (M.children.get(id) || []).length) classes.push('expanded');
      const expanded = classes.includes('expanded');
      // An expanded file is a frame around its class; show the file name so the two differ.
      const label = expanded && n.kind === 'file' ? n.file.split('/').pop() : labelOf(n);
      const tabW = this.large ? 0 : tab; // large graphs draw no icon tab
      const data = { id, label, w, h, tw: w - tabW - 18, tx: tabW / 2, kind: n.kind, group: g, band: BAND[g], ...nodeVisual(n, top, theme, this.large) };
      if (!isTop) data.parent = n.parent;
      else if (mode === 'grouped') groupsUsed.set(g, (groupsUsed.get(g) || 0) + 1);
      els.push({ group: 'nodes', data, classes: classes.join(' ') });
    }
    for (const [g, count] of groupsUsed) {
      // Sized and positioned by groupedPositions().
      els.push({
        group: 'nodes',
        data: { id: 'group:' + g, label: `${GROUPS[g].label}  ${count}`, accent: theme.groups[g], w: 10, h: 10, tw: 600, tx: 0, icon: 'none', fs: 16, group: g, band: BAND[g] },
        classes: 'group',
        selectable: false,
        grabbable: false,
      });
    }
    els.push(...edgeElements(edges));
    return els;
  }

  /** Rebuild the whole graph and lay it out. */
  async render({ keepViewport = false } = {}) {
    const visible = this.visibleSet();
    const edges = this.aggregateEdges(visible);
    const mode = this.chooseMode(visible.size, edges.length);
    this.edgeData = new Map(edges.map((e) => [e.id, e]));
    const cy = this.cy;
    const wasIsolated = this.state.isolated;
    this.state.isolated = false;
    $('#btn-isolate').setAttribute('aria-pressed', 'false');
    const viewport = keepViewport ? { zoom: cy.zoom(), pan: { ...cy.pan() } } : null;
    this.showLoading(`Laying out ${visible.size.toLocaleString()} cards · ${mode === 'flow' ? 'ELK layered' : 'ELK over role groups'}`);
    await nextFrame();
    const els = this.buildElements(visible, edges, mode);
    const t0 = performance.now();
    let usedMode = mode;
    if (mode === 'grouped') await this.groupedPositions(els);
    cy.startBatch();
    cy.elements().remove();
    cy.add(els);
    cy.endBatch();
    if (mode === 'flow') {
      try {
        await this.flowLayout();
      } catch (err) {
        console.error('ELK layout failed, falling back to grouped positions', err);
        await this.groupedPositions(els);
        cy.batch(() => {
          for (const e of els) if (e.position) cy.getElementById(e.data.id).position(e.position);
        });
        usedMode = 'grouped';
      }
    }
    this.lastLayout = { mode: usedMode, ms: Math.round(performance.now() - t0) };
    this.routeEdges({ widen: true });
    this.addLanes();
    this.hideLoading();
    if (viewport) cy.viewport(viewport);
    else this.initialView();
    this.reapplySelection();
    this.minimap.refresh();
    this.updateOverlays();
    this.updateStatus();
    if (wasIsolated && this.state.selected) await this.isolate(true);
  }

  /**
   * Re-aggregate edges only, keeping node positions. With `toggle` (an edge-kind
   * toggle name) only the edges of that kind are removed or added.
   */
  renderEdges(toggle = null) {
    const cy = this.cy;
    const visible = new Set(cy.nodes().not('.group, .lane').map((n) => n.id()));
    if (toggle) {
      const kinds = new Set(Object.keys(TOGGLE_OF).filter((k) => TOGGLE_OF[k] === toggle));
      if (this.state.kinds[toggle]) {
        const added = this.aggregateEdges(visible, kinds);
        for (const e of added) this.edgeData.set(e.id, e);
        cy.batch(() => cy.add(edgeElements(added)));
      } else {
        for (const [id, e] of this.edgeData) if (kinds.has(e.kind)) this.edgeData.delete(id);
        cy.batch(() => cy.edges().filter((e) => kinds.has(e.data('kind'))).remove());
      }
    } else {
      const edges = this.aggregateEdges(visible);
      this.edgeData = new Map(edges.map((e) => [e.id, e]));
      cy.batch(() => {
        cy.edges().remove();
        cy.add(edgeElements(edges));
      });
    }
    this.routeEdges();
    this.reapplySelection();
    this.updateStatus();
  }

  /**
   * Elbow routes for the visible edges (route.js), after every layout and edge change. Grouped
   * layouts of large graphs keep plain lines: their cards are packed in grids, not columns.
   * `widen` (right after a layout): first move columns apart where a channel is too narrow for its
   * tracks, so parallel lines keep their spacing.
   */
  routeEdges({ widen = false } = {}) {
    const cy = this.cy;
    const edges = cy.edges().not('.isolated-out');
    const on = (this.state.isolated || this.lastLayout?.mode === 'flow') && edges.length <= FLOW_LIMIT.edges;
    if (!on) {
      cy.batch(() => cy.edges().removeClass('routed routed-straight'));
      return;
    }
    const cards = cy.nodes().not('.lane, .group, .isolated-out');
    const measure = () => {
      const boxes = new Map();
      cards.forEach((n) => {
        const bb = n.boundingBox({ includeLabels: false, includeOverlays: false, includeUnderlays: false, includeOutlines: false });
        const ancestors = n.ancestors().not('.group');
        boxes.set(n.id(), { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2, top: ancestors.length ? ancestors.last().id() : n.id(), ancestors: ancestors.map((a) => a.id()) });
      });
      return boxes;
    };
    const list = edges.map((e) => ({ id: e.id(), s: e.source().id(), t: e.target().id() }));
    let boxes = measure();
    let { routes, widen: narrow } = computeRoutes(boxes, list);
    if (widen && narrow.length) {
      cy.batch(() => {
        cards.forEach((n) => {
          if (n.isParent()) return; // compound boxes follow their children
          const top = boxes.get(boxes.get(n.id()).top);
          const dx = narrow.filter((w) => top.x1 >= w.at).reduce((sum, w) => sum + w.by, 0);
          if (dx) n.shift({ x: dx, y: 0 });
        });
      });
      boxes = measure();
      ({ routes } = computeRoutes(boxes, list));
    }
    cy.batch(() => {
      cy.edges('.isolated-out').removeClass('routed routed-straight');
      edges.forEach((e) => {
        const route = routes.get(e.id());
        if (!route) {
          e.removeClass('routed routed-straight');
          return;
        }
        const { straight, ...data } = routeStyle(route, e.source().position(), e.target().position());
        e.data(data);
        e.removeClass(straight ? 'routed' : 'routed-straight').addClass(straight ? 'routed-straight' : 'routed');
      });
    });
  }

  setEdgeToggle(kind, on) {
    if (kind === 'uncertain') {
      this.state.uncertain = on;
      this.renderEdges();
    } else {
      this.state.kinds[kind] = on;
      this.renderEdges(kind);
    }
    this.renderLegendBar();
    this.updateBadges();
    if (this.state.tab === 'filters') this.renderPanel();
  }

  updateStatus() {
    const cy = this.cy;
    const nodes = cy.nodes().not('.group, .lane, .isolated-out').length;
    const edges = cy.edges().not('.isolated-out').length;
    $('#status-left').textContent = `${nodes.toLocaleString()} cards · ${edges.toLocaleString()} edges · ${this.lastLayout.mode} layout ${this.lastLayout.ms} ms${this.state.isolated ? ' · isolated' : ''}`;
    $('#status-right').textContent = `${this.meta.stats.files.toLocaleString()} files analyzed in ${this.meta.durationMs.toLocaleString()} ms · ${new Date(this.meta.generatedAt).toLocaleString()}`;
  }

  showLoading(text) {
    $('#loading-text').textContent = text;
    $('#loading').hidden = false;
  }

  hideLoading() {
    $('#loading').hidden = true;
  }

  // --- layouts ------------------------------------------------------------------

  runElk(eles, elkOptions, nodeLayoutOptions) {
    return new Promise((resolve, reject) => {
      this.pendingLayoutReject = reject;
      eles
        .layout({
          name: 'elk',
          fit: false,
          animate: false,
          nodeDimensionsIncludeLabels: false,
          elk: elkOptions,
          nodeLayoutOptions,
          stop: () => {
            this.pendingLayoutReject = null;
            resolve();
          },
        })
        .run();
    });
  }

  /**
   * ELK layered on the cards. Partitions (BAND) give every role its own column,
   * ordered from models to pages; only edges between bands steer the layout, so
   * each band stays a single readable column.
   */
  async flowLayout(eles = this.cy.elements().not('.lane, .group')) {
    const topOf = (n) => {
      let t = n;
      while (t.isChild()) t = t.parent();
      return t;
    };
    const nodes = eles.nodes();
    const layoutEdges = eles.edges().filter((e) => topOf(e.source()).data('band') !== topOf(e.target()).data('band'));
    await this.runElk(
      nodes.union(layoutEdges),
      {
        algorithm: 'layered',
        'elk.direction': 'LEFT',
        'elk.partitioning.activate': true,
        'elk.separateConnectedComponents': false,
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.edgeRouting': 'POLYLINE',
        'elk.layered.spacing.nodeNodeBetweenLayers': 46,
        'elk.spacing.nodeNode': 12,
        // Straight, compact columns (Brandes-Köpf spreads cards out to straighten edges).
        'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      },
      (n) =>
        n.isChild()
          ? n.isParent()
            ? { 'elk.padding': '[top=28,left=10,bottom=10,right=10]' }
            : {}
          : { 'elk.partitioning.partition': String(n.data('band')), ...(n.isParent() ? { 'elk.padding': '[top=30,left=12,bottom=12,right=12]' } : {}) },
    );
    this.cy.batch(() => {
      nodes.forEach((n) => {
        if (n.isParent()) return;
        const lane = laneOf(n.data('group'));
        if (lane === 'be') n.shift({ x: -LANE_GUTTER, y: 0 });
        else if (lane === 'fe') n.shift({ x: LANE_GUTTER, y: 0 });
      });
    });
  }

  /**
   * Large graphs: cards are packed in a grid inside their role group, then ELK
   * layered places the group boxes (a small graph) in the role bands.
   * Works on element JSON before it is added to Cytoscape (it sets `position`),
   * so the main canvas never re-renders a large, not-yet-laid-out graph.
   */
  async groupedPositions(els) {
    const GAP_X = 14;
    const GAP_Y = 10;
    const PAD = 16;
    const has = (e, c) => (' ' + (e.classes || '') + ' ').includes(' ' + c + ' ');
    const nodeEls = els.filter((e) => e.group === 'nodes');
    const byId = new Map(nodeEls.map((e) => [e.data.id, e]));
    const kids = new Map();
    for (const e of nodeEls) {
      if (!e.data.parent) continue;
      if (!kids.has(e.data.parent)) kids.set(e.data.parent, []);
      kids.get(e.data.parent).push(e);
    }
    // Measure each top-level card (expanded files stack their contents vertically).
    const measure = (e) => {
      const children = kids.get(e.data.id);
      if (!children) {
        const { w, h } = e.data;
        return { w, h, place: (x, y) => (e.position = { x: x + w / 2, y: y + h / 2 }) };
      }
      // Compound labels are drawn above the box, so reserve room for them.
      const blocks = children.map(measure);
      const pad = 10; // matches the ':parent' padding style
      const label = has(e, 'file') ? 30 : 18;
      const w = Math.max(...blocks.map((b) => b.w)) + pad * 2;
      const h = label + pad * 2 + blocks.reduce((sum, b) => sum + b.h, 0) + 6 * (blocks.length - 1);
      return {
        w,
        h,
        place: (x, y) => {
          let yy = y + label + pad;
          for (const b of blocks) {
            b.place(x + pad, yy);
            yy += b.h + 6;
          }
        },
      };
    };
    const groups = new Map();
    for (const e of nodeEls) {
      if (!has(e, 'top')) continue;
      const g = e.data.group;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
    const packed = new Map();
    for (const [g, members] of groups) {
      members.sort((a, b) => (a.data.id < b.data.id ? -1 : 1));
      const blocks = members.map(measure);
      const cols = Math.max(1, Math.min(8, Math.round(Math.sqrt(blocks.length / 4))));
      const target = cols * (Math.max(...blocks.map((b) => b.w)) + GAP_X);
      let x = 0;
      let y = 0;
      let rowH = 0;
      let maxW = 0;
      const placed = [];
      for (const b of blocks) {
        if (x > 0 && x + b.w > target) {
          x = 0;
          y += rowH + GAP_Y;
          rowH = 0;
        }
        placed.push({ b, x, y });
        x += b.w + GAP_X;
        rowH = Math.max(rowH, b.h);
        maxW = Math.max(maxW, x - GAP_X);
      }
      // Title size follows the box width (readable when the whole graph is fitted);
      // its height is reserved so ELK keeps titles clear of neighbouring groups.
      const w = maxW + PAD * 2;
      const fs = Math.round(clamp(w / 12, 16, 120));
      const head = Math.round(fs * 1.4) + 10;
      packed.set(g, { w, h: y + rowH + PAD + head, head, fs, placed });
    }
    // Group-level graph for ELK (only edges between bands steer it).
    const groupEdges = new Set();
    for (const e of els) {
      if (e.group !== 'edges') continue;
      const a = byId.get(e.data.source)?.data.group;
      const b = byId.get(e.data.target)?.data.group;
      if (a && b && a !== b && BAND[a] !== BAND[b]) groupEdges.add(a + '|' + b);
    }
    const hcy = cytoscape({
      headless: true,
      styleEnabled: true,
      style: [{ selector: 'node', style: { width: 'data(w)', height: 'data(h)', shape: 'rectangle' } }],
      elements: [
        ...[...packed].map(([g, p]) => ({ data: { id: g, w: p.w, h: p.h, band: BAND[g], order: GROUP_ORDER.indexOf(g) } })),
        ...[...groupEdges].map((k) => {
          const [source, target] = k.split('|');
          return { data: { id: k, source, target } };
        }),
      ],
    });
    // Model order = GROUP_ORDER, so groups without edges keep a stable, meaningful order.
    const sortedNodes = hcy.nodes().sort((a, b) => a.data('order') - b.data('order'));
    await this.runElk(
      sortedNodes.union(hcy.edges()),
      {
        algorithm: 'layered',
        'elk.direction': 'LEFT',
        'elk.partitioning.activate': true,
        'elk.separateConnectedComponents': false,
        'elk.edgeRouting': 'POLYLINE',
        'elk.layered.spacing.nodeNodeBetweenLayers': 120,
        'elk.spacing.nodeNode': 70,
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      },
      (n) => ({ 'elk.partitioning.partition': String(n.data('band')) }),
    );
    for (const [g, p] of packed) {
      const pos = hcy.getElementById(g).position();
      const lane = laneOf(g);
      const shift = lane === 'be' ? -LANE_GUTTER * 2 : lane === 'fe' ? LANE_GUTTER * 2 : 0;
      const ox = pos.x + shift - p.w / 2 + PAD;
      const oy = pos.y - p.h / 2 + p.head;
      for (const { b, x, y } of p.placed) b.place(ox + x, oy + y);
      // The box covers the packed cards; its title sits above it.
      const box = byId.get('group:' + g);
      if (box) {
        box.data.w = p.w;
        box.data.h = p.h - p.head + PAD;
        box.data.fs = p.fs;
        box.data.tw = p.w;
        box.position = { x: pos.x + shift, y: pos.y + (p.head - PAD) / 2 };
      }
    }
    hcy.destroy();
  }

  /** Tinted lanes behind the backend / endpoints / frontend columns (equal height, room for the header). */
  addLanes() {
    const cy = this.cy;
    cy.remove('.lane');
    const boxes = {};
    cy.nodes('.top, .group')
      .filter((n) => !n.hasClass('isolated-out'))
      .forEach((n) => {
        const lane = laneOf(n.data('group'));
        let bb;
        if (n.isParent()) bb = n.boundingBox({ includeLabels: true });
        else {
          // boundingBox() is slow on thousands of nodes; sizes are known except for compounds.
          const p = n.position();
          const w = n.data('w') / 2;
          const h = n.data('h') / 2;
          bb = { x1: p.x - w, x2: p.x + w, y1: p.y - h - (n.hasClass('group') ? n.data('fs') * 1.4 + 10 : 0), y2: p.y + h };
        }
        const b = (boxes[lane] ||= { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity, count: 0 });
        b.x1 = Math.min(b.x1, bb.x1);
        b.x2 = Math.max(b.x2, bb.x2);
        b.y1 = Math.min(b.y1, bb.y1);
        b.y2 = Math.max(b.y2, bb.y2);
        if (!n.hasClass('group')) b.count++;
      });
    this.laneBoxes = {};
    const list = Object.entries(boxes);
    if (!list.length) return;
    const y1 = Math.min(...list.map(([, b]) => b.y1)) - 70; // room under the pinned lane header
    const y2 = Math.max(...list.map(([, b]) => b.y2)) + 36;
    const padX = 22;
    for (const [lane, b] of list) {
      const x1 = b.x1 - padX;
      const x2 = b.x2 + padX;
      this.laneBoxes[lane] = { x1, x2, y1, y2, count: b.count };
      cy.add({
        group: 'nodes',
        data: { id: 'lane:' + lane, lane, w: x2 - x1, h: y2 - y1, accent: this.theme.lanes[lane], label: '', tw: 0, tx: 0, icon: 'none' },
        position: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
        classes: 'lane',
        selectable: false,
        grabbable: false,
      });
    }
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const sub = { be: plural(this.laneBoxes.be?.count ?? 0, 'file'), ep: plural(this.laneBoxes.ep?.count ?? 0, 'endpoint'), fe: plural(this.laneBoxes.fe?.count ?? 0, 'file') };
    // Natural widths, full and compact, so a header never clips its title (updateOverlays places them).
    for (const [lane, el] of Object.entries(this.laneHeads)) {
      el.querySelector('span:last-child').textContent = sub[lane];
      el.hidden = false;
      el.classList.remove('compact');
      const full = el.offsetWidth;
      el.classList.add('compact');
      el.dataset.full = String(full);
      el.dataset.compact = String(el.offsetWidth);
    }
  }

  // --- viewport -------------------------------------------------------------------

  /**
   * Fit a collection, keeping clear of the lane headers and the bottom docks. With
   * `minZoom`, never zoom out further than that: the drawing stays centred and
   * top-aligned, and the minimap shows what is off-screen.
   */
  fitTo(eles, animate = true, maxZoom = 1.25, minZoom = 0) {
    const cy = this.cy;
    if (!eles || eles.empty()) return;
    const bb = eles.boundingBox({ includeLabels: false });
    const W = cy.width();
    const H = cy.height();
    const availH = H - FIT_PAD.top - FIT_PAD.bottom;
    const z = clamp(Math.min((W - FIT_PAD.x * 2) / bb.w, availH / bb.h), Math.max(cy.minZoom(), minZoom), maxZoom);
    const y = bb.h * z <= availH ? FIT_PAD.top + (availH - bb.h * z) / 2 - bb.y1 * z : FIT_PAD.top - bb.y1 * z;
    const pan = { x: (W - bb.w * z) / 2 - bb.x1 * z, y };
    if (animate) cy.animate({ zoom: z, pan }, { duration: 280, easing: 'ease-out-cubic' });
    else cy.viewport({ zoom: z, pan });
  }

  fitAll(animate = true, readable = false) {
    const lanes = this.cy.nodes('.lane');
    const floor = readable && this.lastLayout.mode === 'flow' ? READABLE_ZOOM : 0;
    this.fitTo(lanes.nonempty() ? lanes : this.cy.nodes().not('.isolated-out'), animate, 1.25, floor);
  }

  /**
   * The view a layout opens with. Small maps fit whole. When a whole fit would be too small to read (large
   * grouped maps), fit the lanes' width instead, top-aligned under the lane headers, and scroll the suggested
   * start into view, marked until the first click (F still fits everything).
   */
  initialView() {
    const cy = this.cy;
    this.fitAll(false, true);
    const lanes = cy.nodes('.lane');
    if (this.lastLayout.mode === 'flow' || lanes.empty() || cy.zoom() >= OVERVIEW_BELOW) return;
    const bb = lanes.boundingBox({ includeLabels: false });
    const W = cy.width();
    const H = cy.height();
    const z = clamp((W - FIT_PAD.x * 2) / bb.w, cy.zoom(), 1.25);
    const pan = { x: (W - bb.w * z) / 2 - bb.x1 * z, y: FIT_PAD.top - bb.y1 * z };
    const start = this.hinted ? null : suggestedStart(this);
    const node = start?.id ? cy.getElementById(start.id) : null;
    if (node?.nonempty()) {
      this.hinted = true;
      const y = node.position('y') * z + pan.y;
      if (y > H - FIT_PAD.bottom - 60) pan.y = H / 2 - node.position('y') * z;
      node.addClass('start-hint');
      cy.one('tap', () => node.removeClass('start-hint'));
    }
    cy.viewport({ zoom: z, pan });
  }

  zoomBy(factor) {
    const cy = this.cy;
    const z1 = cy.zoom();
    const z2 = clamp(z1 * factor, cy.minZoom(), cy.maxZoom());
    const c = { x: cy.width() / 2, y: cy.height() / 2 };
    const p = cy.pan();
    cy.animate({ zoom: z2, pan: { x: c.x - ((c.x - p.x) * z2) / z1, y: c.y - ((c.y - p.y) * z2) / z1 } }, { duration: 160, easing: 'ease-out-cubic' });
  }

  scheduleOverlays() {
    if (this.overlayFrame) return;
    this.overlayFrame = requestAnimationFrame(() => {
      this.overlayFrame = 0;
      this.updateOverlays();
    });
  }

  /** Dot grid, zoom level and lane headers follow the viewport. */
  updateOverlays() {
    const cy = this.cy;
    const z = cy.zoom();
    const pan = cy.pan();
    const stage = $('#stage');
    let step = 24;
    while (step * z < 14) step *= 2;
    while (step * z > 56) step /= 2;
    stage.style.backgroundSize = `${step * z}px ${step * z}px`;
    stage.style.backgroundPosition = `${pan.x}px ${pan.y}px`;
    $('#zoom-level').textContent = Math.round(z * 100) + '%';
    // Group titles keep a readable on-screen size (~17px) at any zoom, capped by their box width.
    // Restyling during a wheel/drag gesture defeats Cytoscape's texture fast path, so wait for it to settle.
    clearTimeout(this.groupFontTimer);
    this.groupFontTimer = setTimeout(() => {
      const groups = cy.nodes('.group');
      const zz = cy.zoom();
      if (groups.nonempty()) cy.batch(() => groups.forEach((g) => g.style('font-size', Math.min(g.data('fs'), 17 / zz))));
    }, 140);
    const W = cy.width();
    const shown = [];
    for (const lane of ['be', 'ep', 'fe']) {
      const el = this.laneHeads[lane];
      const b = this.laneBoxes[lane];
      const left = b ? Math.max(b.x1 * z + pan.x, 8) : 0;
      const right = b ? Math.min(b.x2 * z + pan.x, W - 8) : 0;
      if (!b || right - left < 40) {
        el.hidden = true;
        continue;
      }
      const compact = right - left < Number(el.dataset.full) + 16;
      shown.push({ el, compact, center: (left + right) / 2, w: Number(el.dataset[compact ? 'compact' : 'full']) });
    }
    // Centered on their lanes; when lanes are narrower than their headers, push overlapping headers apart.
    let prevRight = 0;
    for (const h of shown) {
      const x1 = Math.max(h.center - h.w / 2, prevRight + 6);
      prevRight = x1 + h.w;
      h.el.hidden = false;
      h.el.classList.toggle('compact', h.compact);
      h.el.style.left = `${x1 + h.w / 2}px`;
    }
  }

  // --- focus, selection, expansion ---------------------------------------------

  focusDepthFor(n) {
    if (this.state.depth !== 'auto') return this.state.depth;
    const kind = n.data('kind');
    return kind === 'endpoint' || kind === 'unmatched' ? 'chain' : '1';
  }

  /** Fade everything outside the node's neighbourhood/chain; returns the kept elements. */
  applyFocus(node) {
    const cy = this.cy;
    let kept = cy.collection();
    cy.batch(() => {
      cy.elements().removeClass('faded hl focus');
      if (!node || node.empty()) return;
      const seeds = node.union(node.descendants());
      const depth = this.focusDepthFor(node);
      let eles;
      if (depth === 'chain') {
        eles = seeds.union(chain(seeds, 'out')).union(chain(seeds, 'in'));
      } else {
        eles = seeds.union(seeds.connectedEdges()).union(seeds.neighborhood());
        if (depth === '2') {
          const ring = eles.nodes();
          eles = eles.union(ring.connectedEdges()).union(ring.neighborhood());
        }
      }
      const nodes = eles.nodes();
      kept = nodes.union(nodes.ancestors()).union(eles.edges());
      cy.elements().not(kept).not('.lane, .group').addClass('faded');
      eles.edges().addClass('hl');
      node.addClass('focus');
    });
    return kept;
  }

  /** Show only the focused chain and lay it out on its own; positions are restored afterwards. */
  async isolate(on) {
    const cy = this.cy;
    const node = this.state.selected ? cy.getElementById(this.state.selected) : cy.collection();
    if (on && node.empty()) {
      this.toast({ icon: 'target', text: 'Select a node first, then isolate its chain.', timeout: 2600 });
      return;
    }
    if (this.state.isolated) {
      cy.batch(() => {
        cy.elements().removeClass('isolated-out');
        for (const [id, pos] of this.savedPositions || []) cy.getElementById(id).position(pos);
      });
      this.state.isolated = false;
      this.routeEdges();
      this.addLanes();
      this.dismissToast('isolate');
    }
    if (on) {
      this.savedPositions = new Map(cy.nodes().filter((n) => !n.isParent() && !n.hasClass('lane')).map((n) => [n.id(), { ...n.position() }]));
      const kept = this.applyFocus(node);
      cy.batch(() => cy.elements().not(kept).addClass('isolated-out'));
      this.state.isolated = true;
      this.showLoading(`Laying out ${kept.nodes().length} cards`);
      await nextFrame();
      try {
        await this.flowLayout(kept);
      } finally {
        this.hideLoading();
      }
      this.routeEdges({ widen: true });
      this.addLanes();
      this.toast({ id: 'isolate', icon: 'target', text: `Isolated chain · ${kept.nodes().not(':parent').length} cards`, actions: [{ label: 'Exit', run: () => this.isolate(false) }] });
    }
    $('#btn-isolate').setAttribute('aria-pressed', String(this.state.isolated));
    this.fitAll(true);
    this.minimap.refresh();
    this.updateStatus();
    if (this.state.tab === 'inspect') this.renderPanel();
  }

  select(id, { center = false } = {}) {
    this.state.selected = id;
    this.state.selectedEdge = null;
    const node = this.cy.getElementById(id);
    this.cy.elements().unselect();
    this.setTab('inspect', false);
    if (node.nonempty() && this.state.isolated) {
      node.select();
      this.renderPanel();
      this.isolate(true);
      return;
    }
    if (node.nonempty()) {
      node.select();
      const kept = this.applyFocus(node);
      // Show the whole focused neighbourhood/chain, but never zoom in absurdly far.
      if (center) this.fitTo(kept.nodes().length > 1 ? kept.nodes() : node, true, 1.1);
    }
    this.renderPanel();
    this.minimap.refresh();
  }

  reapplySelection() {
    const id = this.state.selected;
    if (!id) return;
    const node = this.cy.getElementById(id);
    if (node.nonempty()) {
      node.select();
      this.applyFocus(node);
    } else this.applyFocus(null);
  }

  reset() {
    if (this.state.isolated) this.isolate(false);
    this.state.selected = null;
    this.state.selectedEdge = null;
    this.cy.elements().unselect();
    this.applyFocus(null);
    this.cy.nodes('.search-hit').removeClass('search-hit');
    this.renderPanel();
    this.minimap.refresh();
  }

  /** Make a node visible (expanding its file or un-hiding its group), then select it. */
  async reveal(id) {
    const { M, state } = this;
    if (!M.byId.has(id)) return;
    const top = M.topOf.get(id);
    let changed = false;
    const g = groupKey(M.byId.get(top));
    if (state.hiddenGroups.has(g)) {
      state.hiddenGroups.delete(g);
      changed = true;
      this.updateBadges();
    }
    if (top !== id && !state.expanded.has(top)) {
      state.expanded.add(top);
      changed = true;
    }
    state.selected = id;
    this.cy.nodes('.search-hit').removeClass('search-hit');
    if (changed) await this.render({ keepViewport: true });
    this.select(id, { center: true });
  }

  async toggleExpand(id) {
    const { M, state } = this;
    if (!(M.children.get(id) || []).length) return;
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    state.selected = id;
    await this.render({ keepViewport: true });
    this.select(id, { center: true });
  }

  openInEditor(id) {
    const url = editorUrl(this.M.byId.get(id), this.meta);
    if (!url) return;
    openLink(url);
    this.toast({ icon: 'external', text: `Opening ${esc(displayName(this.M, id))}${inWebview ? '' : ' in VS Code'}…`, timeout: 2200 });
  }

  /** Messages from the editor extension (webview only). */
  onHostMessage(msg) {
    if (msg.type === 'stale') {
      this.toast({
        id: 'stale',
        icon: 'alert',
        text: `<b>${msg.files === 1 ? '1 file' : `${msg.files} files`} changed</b> since this map was made.`,
        actions: [{ label: 'Refresh', run: () => postToHost({ type: 'refresh' }) }],
      });
    } else if (msg.type === 'activeFile') {
      this.cy.nodes('.active-file').removeClass('active-file');
      if (msg.id) this.cy.getElementById(msg.id).addClass('active-file');
    } else if (msg.type === 'reveal') {
      if (this.M.byId.has(msg.id) && this.cy.getElementById(msg.id).nonempty()) this.select(msg.id, { center: true });
      else this.toast({ icon: 'alert', text: `${esc(msg.file)} is not on the map (not part of the analyzed projects, or excluded).`, timeout: 3500 });
    } else if (msg.type === 'test' && testMode) this.onTest(msg);
  }

  /** The extension's integration tests drive the viewer through these (only when it runs its test suite). */
  onTest(msg) {
    const reply = (data) => postToHost({ type: 'testResult', seq: msg.seq, ...data });
    if (msg.action === 'open') this.openInEditor(msg.id);
    if (msg.action === 'lens') this.setSecLens(msg.on);
    if (msg.action === 'tab') this.setTab(msg.tab);
    reply({
      cards: this.cy.nodes().not('.lane, .group').length,
      selected: this.state.selected ?? null,
      tab: this.state.tab,
      secLens: Boolean(this.state.secLens),
      securityTab: !document.querySelector('.tabs [data-tab="security"]').hidden,
      theme: this.theme.name,
      activeFile: this.cy.nodes('.active-file').map((n) => n.id()),
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
      panel: document.querySelector('#panel-body').textContent.replace(/\s+/g, ' ').slice(0, 2000),
    });
  }

  // --- panel ----------------------------------------------------------------------

  setTab(tab, render = true) {
    this.state.tab = tab;
    for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    if (render) this.renderPanel();
  }

  renderPanel() {
    const { state } = this;
    let html;
    if (state.tab === 'insights') html = renderInsights(this);
    else if (state.tab === 'security') html = renderSecurity(this);
    else if (state.tab === 'filters') html = renderFilters(this);
    else if (state.selectedEdge && this.edgeData.get(state.selectedEdge)) html = renderInspectEdge(this, this.edgeData.get(state.selectedEdge));
    else if (state.selected) html = renderInspectNode(this, state.selected);
    else html = renderInspectEmpty(this);
    const body = $('#panel-body');
    body.innerHTML = html;
    body.scrollTop = 0;
  }

  // --- search -----------------------------------------------------------------------

  showSearchResults(list, q) {
    const box = $('#search-results');
    this.searchList = list;
    this.searchIndex = 0;
    if (!q.trim()) {
      box.hidden = true;
      return;
    }
    const rows = list
      .map((n, i) => {
        const top = this.M.byId.get(this.M.topOf.get(n.id)) ?? n;
        const g = groupKey(top);
        const color = n.kind === 'endpoint' || n.kind === 'unmatched' ? methodColor(this.theme, n.method) : this.theme.groups[g];
        const name =
          n.kind === 'endpoint' || n.kind === 'unmatched'
            ? `${methodPill(this, n.method)} <span class="mono hl-text">${highlight(n.path || n.name, q)}</span>`
            : `<span class="hl-text">${highlight(displayName(this.M, n.id), q)}</span>`;
        return `<button class="result ${i === 0 ? 'active' : ''}" data-i="${i}">
          <span class="row-icon" style="--c:${color}">${icon(iconOf(n, GROUPS[g]?.icon), 14)}</span>
          <span class="row-main"><span class="row-title">${name}</span><span class="row-sub">${esc(n.file || '')}</span></span>
          <span class="result-kind">${esc(n.kind)}</span></button>`;
      })
      .join('');
    box.innerHTML = list.length
      ? `<div class="search-meta"><span>${list.length}${list.length === 40 ? '+' : ''} results</span><span>↑↓ move · ↵ open · esc close</span></div>${rows}`
      : `<div class="search-empty">No matches for “${esc(q)}”</div>`;
    box.hidden = false;
    this.cy.batch(() => {
      this.cy.nodes('.search-hit').removeClass('search-hit');
      for (const n of list) this.cy.getElementById(n.id).addClass('search-hit');
    });
  }

  // --- tooltip & toasts ---------------------------------------------------------------

  showTooltip(id, rendered) {
    const tip = $('#tooltip');
    tip.innerHTML = tooltipHtml(this, id);
    tip.hidden = false;
    this.moveTooltip(rendered);
  }

  moveTooltip(p) {
    const tip = $('#tooltip');
    if (tip.hidden) return;
    const W = this.cy.width();
    const H = this.cy.height();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = p.x + 16;
    let y = p.y + 18;
    if (x + w > W - 8) x = p.x - w - 16;
    if (y + h > H - 8) y = p.y - h - 14;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  hideTooltip() {
    clearTimeout(this.tipTimer);
    $('#tooltip').hidden = true;
  }

  toast({ id, icon: ico = 'sparkle', text, actions = [], timeout = 0 }) {
    if (id) this.dismissToast(id);
    const el = document.createElement('div');
    el.className = 'toast';
    if (id) el.dataset.toast = id;
    el.innerHTML = `${icon(ico, 16)}<span>${text}</span>${actions.map((a, i) => `<button class="btn" data-i="${i}">${esc(a.label)}</button>`).join('')}`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      actions[Number(b.dataset.i)].run();
      el.remove();
    });
    $('#toasts').appendChild(el);
    if (timeout) setTimeout(() => el.remove(), timeout);
    return el;
  }

  dismissToast(id) {
    for (const el of document.querySelectorAll(`.toast[data-toast="${id}"]`)) el.remove();
  }

  onboarding() {
    if (store.get('seammap.onboarded')) return;
    const done = () => store.set('seammap.onboarded', '1');
    // A big map reads as a wall of cards until something is focused: offer the suggested start right away.
    const start = this.large ? suggestedStart(this) : null;
    if (start?.classify) {
      const unknown = this.M.graph.security.summary.unknown;
      this.toast({
        id: 'onboarding',
        icon: 'shield',
        text: `<b>${this.M.top.length.toLocaleString()} cards.</b> First step: classify <b>${start.classify.middleware.length} middleware</b> to resolve ${start.classify.endpoints.toLocaleString()} of the ${unknown.toLocaleString()} unknown endpoints in the security lens.`,
        actions: [
          { label: 'Show them', run: () => (done(), this.setTab('security')) },
          { label: 'Later', run: done },
        ],
      });
      return;
    }
    if (start) {
      this.toast({
        id: 'onboarding',
        icon: 'sparkle',
        text: `<b>${this.M.top.length.toLocaleString()} cards.</b> A good place to start: <b>${esc(displayName(this.M, start.id))}</b> (${esc(start.why.toLowerCase())}).`,
        actions: [
          { label: 'Trace it', run: () => this.startWith(start.id) },
          { label: 'Later', run: done },
        ],
      });
      return;
    }
    this.toast({
      id: 'onboarding',
      icon: 'sparkle',
      text: '<b>Tip:</b> click an endpoint in the middle lane to trace its whole chain. Double-click a file to see its methods.',
      actions: [{ label: 'Got it', run: done }],
    });
  }

  /** The suggested start: focus its chain, and on big maps isolate it so it gets a layout of its own. */
  async startWith(id) {
    store.set('seammap.onboarded', '1');
    this.dismissToast('onboarding');
    this.select(id, { center: true });
    if (this.large && !this.state.isolated) await this.isolate(true);
  }

  setMinimap(on, remember = true) {
    $('#minimap').hidden = !on;
    $('#map-toggle').setAttribute('aria-pressed', String(on));
    if (remember) store.set('seammap.minimap', on ? 'on' : 'off');
    if (on) this.minimap.refresh();
  }

  togglePanel() {
    document.body.classList.toggle('panel-collapsed');
    store.set('seammap.panel', document.body.classList.contains('panel-collapsed') ? 'collapsed' : 'open');
    setTimeout(() => {
      this.cy.resize();
      this.minimap.refresh();
      this.updateOverlays();
    }, 220);
  }

  // --- events -------------------------------------------------------------------------

  bind() {
    const cy = this.cy;
    const isCard = (n) => !n.hasClass('lane') && !n.hasClass('group');
    cy.on('tap', 'node', (e) => {
      if (isCard(e.target)) this.select(e.target.id());
    });
    cy.on('tap', 'edge', (e) => {
      const edge = e.target;
      this.state.selected = null;
      this.state.selectedEdge = edge.id();
      cy.batch(() => {
        cy.elements().removeClass('faded hl focus');
        const ends = edge.connectedNodes();
        cy.elements().not(ends.union(ends.ancestors()).union(edge)).not('.lane, .group').addClass('faded');
        edge.addClass('hl');
      });
      this.setTab('inspect');
    });
    cy.on('tap', (e) => {
      if (e.target === cy) this.reset();
    });
    cy.on('dbltap', 'node', (e) => {
      if (!isCard(e.target)) return;
      const id = e.target.id();
      if ((this.M.children.get(id) || []).length) this.toggleExpand(id);
      else this.openInEditor(id);
    });
    cy.on('cxttap', 'node', (e) => isCard(e.target) && this.openInEditor(e.target.id()));
    cy.on('mouseover', 'node', (e) => {
      const n = e.target;
      if (!isCard(n)) return;
      n.addClass('hover');
      n.connectedEdges().addClass('hover-hl');
      clearTimeout(this.tipTimer);
      const p = e.renderedPosition;
      this.tipTimer = setTimeout(() => this.showTooltip(n.id(), p), 280);
    });
    cy.on('mousemove', 'node', (e) => this.moveTooltip(e.renderedPosition));
    cy.on('mouseout', 'node', (e) => {
      e.target.removeClass('hover');
      e.target.connectedEdges().removeClass('hover-hl');
      this.hideTooltip();
    });
    cy.on('viewport', () => {
      this.hideTooltip();
      this.scheduleOverlays();
    });
    cy.on('resize', () => this.scheduleOverlays());

    // Toolbar
    for (const seg of document.querySelectorAll('.seg')) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-value]');
        if (!b) return;
        for (const x of seg.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
        if (seg.dataset.seg === 'depth') {
          this.state.depth = b.dataset.value;
          if (this.state.isolated) this.isolate(true);
          else this.reapplySelection();
        } else {
          this.state.layout = b.dataset.value;
          this.render();
        }
      });
    }
    $('#btn-isolate').addEventListener('click', () => this.isolate(!this.state.isolated));
    $('#btn-sec').addEventListener('click', () => this.setSecLens(!this.state.secLens));
    $('#btn-collapse').addEventListener('click', () => {
      this.state.expanded.clear();
      this.render();
    });
    $('#btn-relayout').addEventListener('click', () => this.render());
    $('#btn-theme').addEventListener('click', () => this.applyTheme(this.theme.name === 'dark' ? 'light' : 'dark'));
    $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());
    $('#btn-panel').addEventListener('click', () => this.togglePanel());
    document.querySelector('[data-close-dialog]').addEventListener('click', () => $('#help-dialog').close());

    // Canvas docks
    $('#zoom-in').addEventListener('click', () => this.zoomBy(1.25));
    $('#zoom-out').addEventListener('click', () => this.zoomBy(0.8));
    $('#zoom-fit').addEventListener('click', () => this.fitAll(true));
    $('#zoom-level').addEventListener('click', () => this.zoomBy(1 / cy.zoom()));
    $('#map-toggle').addEventListener('click', () => this.setMinimap($('#minimap').hidden));
    $('#legend-bar').addEventListener('click', (e) => {
      const b = e.target.closest('.legend-chip');
      if (!b) return;
      if (b.hasAttribute('data-uncertain')) this.setEdgeToggle('uncertain', !this.state.uncertain);
      else this.setEdgeToggle(b.dataset.kind, !this.state.kinds[b.dataset.kind]);
    });
    $('#lane-heads').addEventListener('click', (e) => {
      const h = e.target.closest('.lane-head');
      if (h) this.fitTo(cy.getElementById('lane:' + h.dataset.lane), true, 1.1);
    });

    // Panel
    for (const b of document.querySelectorAll('.tabs [data-tab]')) b.addEventListener('click', () => this.setTab(b.dataset.tab));
    $('#panel-body').addEventListener('click', (e) => {
      const t = e.target;
      const reveal = t.closest('[data-reveal]');
      if (reveal) {
        e.preventDefault();
        this.reveal(reveal.dataset.reveal);
        return;
      }
      const action = t.closest('[data-action]');
      if (action) {
        if (action.dataset.action === 'isolate') this.isolate(!this.state.isolated);
        if (action.dataset.action === 'expand') this.toggleExpand(action.dataset.id);
        if (action.dataset.action === 'reach') this.showReach(action.dataset.id);
        if (action.dataset.action === 'start') this.startWith(action.dataset.id);
        return;
      }
      const secFindings = t.closest('[data-sec-findings]');
      if (secFindings) {
        this.state.secFindings = secFindings.dataset.secFindings;
        this.renderPanel();
        return;
      }
      const secFilter = t.closest('[data-sec-filter]');
      if (secFilter) {
        this.state.secFilter = this.state.secFilter === secFilter.dataset.secFilter ? null : secFilter.dataset.secFilter;
        this.renderPanel();
        return;
      }
      const copy = t.closest('[data-copy]');
      if (copy) {
        navigator.clipboard?.writeText(copy.dataset.copy).then(
          () => this.toast({ icon: 'copy', text: 'Path copied', timeout: 1600 }),
          () => {},
        );
        return;
      }
      const goto = t.closest('[data-goto-tab]');
      if (goto) this.setTab(goto.dataset.gotoTab);
      const all = t.closest('[data-lane-all], [data-lane-none]');
      if (all) {
        const lane = all.dataset.laneAll ?? all.dataset.laneNone;
        for (const g of GROUP_ORDER) {
          if (laneOf(g) !== lane) continue;
          if (all.dataset.laneAll) this.state.hiddenGroups.delete(g);
          else this.state.hiddenGroups.add(g);
        }
        this.updateBadges();
        this.renderPanel();
        this.render();
      }
    });
    $('#panel-body').addEventListener('change', (e) => {
      const t = e.target;
      if (t.hasAttribute('data-sec-lens')) this.setSecLens(t.checked);
      else if (t.dataset.kind) this.setEdgeToggle(t.dataset.kind, t.checked);
      else if (t.hasAttribute('data-uncertain')) this.setEdgeToggle('uncertain', t.checked);
      else if (t.dataset.group) {
        if (t.checked) this.state.hiddenGroups.delete(t.dataset.group);
        else this.state.hiddenGroups.add(t.dataset.group);
        this.updateBadges();
        this.render();
      }
    });

    // Search
    const input = $('#search');
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.showSearchResults(search(this.M, input.value), input.value), 110);
    });
    input.addEventListener('focus', () => input.value.trim() && this.showSearchResults(search(this.M, input.value), input.value));
    input.addEventListener('keydown', (e) => {
      const box = $('#search-results');
      const items = [...box.querySelectorAll('.result')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        this.searchIndex = (this.searchIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('active', i === this.searchIndex));
        items[this.searchIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        const n = this.searchList?.[this.searchIndex];
        if (n) {
          box.hidden = true;
          // Hand the keyboard back to the graph so shortcuts (I, Esc) work right away.
          input.blur();
          this.reveal(n.id);
        }
      } else if (e.key === 'Escape') {
        box.hidden = true;
        input.blur();
      }
    });
    $('#search-results').addEventListener('mousedown', (e) => {
      const b = e.target.closest('.result');
      if (!b) return;
      e.preventDefault();
      const n = this.searchList[Number(b.dataset.i)];
      $('#search-results').hidden = true;
      input.blur();
      if (n) this.reveal(n.id);
    });
    input.addEventListener('blur', () => setTimeout(() => ($('#search-results').hidden = true), 150));

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target === input || e.target.closest?.('dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === 'Escape') this.reset();
      else if (k === '/') {
        e.preventDefault();
        input.focus();
        input.select();
      } else if (k === 'i' || k === 'I') this.isolate(!this.state.isolated);
      else if (k === 'f' || k === 'F') this.fitAll(true);
      else if (k === '+' || k === '=') this.zoomBy(1.25);
      else if (k === '-' || k === '_') this.zoomBy(0.8);
      else if ((k === 'e' || k === 'E') && this.state.selected) this.toggleExpand(this.M.topOf.get(this.state.selected));
      else if ((k === 'o' || k === 'O') && this.state.selected) this.openInEditor(this.state.selected);
      else if (k === 't' || k === 'T') this.applyTheme(this.theme.name === 'dark' ? 'light' : 'dark');
      else if (k === 'p' || k === 'P') this.togglePanel();
      else if ((k === 's' || k === 'S') && this.sec) this.setSecLens(!this.state.secLens);
      else if (k === '?') $('#help-dialog').showModal();
    });
    window.addEventListener('resize', () => this.minimap.refresh());
  }
}

// ---------------------------------------------------------------------------------------

async function main() {
  cytoscape.use(cytoscapeElk);
  // cytoscape-elk does not surface ELK errors; reject the pending layout so we can fall back.
  const origLayout = ELK.prototype.layout;
  ELK.prototype.layout = function (...args) {
    return origLayout.apply(this, args).catch((err) => {
      window.seammap?.pendingLayoutReject?.(err);
      return new Promise(() => {}); // swallow: cytoscape-elk has no rejection handler
    });
  };
  for (const el of document.querySelectorAll('[data-icon]')) el.outerHTML = icon(el.dataset.icon, 16, el.className);
  // In VS Code the editor's theme decides; in a browser, the last choice or the system preference.
  const saved = store.get('seammap.theme');
  const themeName = editorTheme() ?? (saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  if (inWebview) $('#btn-theme').hidden = true;
  document.documentElement.dataset.theme = themeName;
  if (store.get('seammap.panel') === 'collapsed') document.body.classList.add('panel-collapsed');
  // Canvas labels need the web fonts before the first draw (Cytoscape caches label bitmaps).
  const fonts = ['500 13px "IBM Plex Sans"', '400 12px "IBM Plex Sans"', '500 12px "IBM Plex Mono"', '700 16px "Space Grotesk"'].map((f) => document.fonts.load(f));
  await Promise.race([Promise.all(fonts), new Promise((r) => setTimeout(r, 2500))]);
  let graph;
  try {
    const res = await fetch(graphUrl, { cache: 'no-store' });
    graph = await res.json();
  } catch (err) {
    $('#status-left').textContent = 'Could not load graph.json: ' + err.message;
    postToHost({ type: 'loadError', message: err.message });
    return;
  }
  // A file from another format version would render wrongly or fail halfway: say so instead.
  const problem = checkSchema(graph);
  if (problem) {
    $('#load-problem-text').textContent = problem.message;
    $('#load-problem').hidden = false;
    $('#status-left').textContent = 'graph.json not shown';
    postToHost({ type: 'schemaProblem', kind: problem.kind, message: problem.message });
    return;
  }
  const app = new App(graph, themeName);
  window.seammap = app;
  onHostMessage((msg) => app.onHostMessage(msg));
  onEditorTheme((name) => app.applyTheme(name, false));
  await app.render();
  app.onboarding();
  postToHost({ type: 'ready', cards: app.cy.nodes().not('.lane, .group').length });
  // When the first frame of the map has been drawn (the extension's timing tests compare the two).
  const readyAt = performance.now();
  requestAnimationFrame(() => setTimeout(() => postToHost({ type: 'painted', ms: Math.round(performance.now() - readyAt) }), 0));
}

main();
