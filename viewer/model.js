// Indexes over graph.json plus naming, sizing and search helpers (no DOM, no Cytoscape).

import { BADGE_W, TAB_W } from './icons.js';

export function feCategory(n) {
  const k = n.nextKind;
  if (k === 'page') return 'page';
  if (k === 'route' || k === 'api') return 'route';
  if (k) return 'layout';
  const p = '/' + n.file;
  if (/\/hooks?\//.test(p) || /\/use[A-Z][^/]*$/.test(p)) return 'hook';
  if (/\/components?\//.test(p)) return 'component';
  if (/\/(lib|libs|utils?|services?|api|helpers?|store|stores|actions|queries|clients?)\//.test(p)) return 'lib';
  return 'other';
}

export function groupKey(n) {
  if (n.kind === 'endpoint') return n.server === 'next' ? 'ep:next' : 'ep:laravel';
  if (n.kind === 'unmatched') return 'ep:unmatched';
  if (n.side === 'backend') return 'be:' + (n.role || 'other');
  return 'fe:' + feCategory(n);
}

export function buildModel(graph) {
  const byId = new Map();
  const children = new Map();
  for (const n of graph.nodes) byId.set(n.id, n);
  for (const n of graph.nodes) {
    if (!n.parent || !byId.has(n.parent)) continue;
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n.id);
  }
  for (const list of children.values()) list.sort((a, b) => (byId.get(a).line || 0) - (byId.get(b).line || 0));
  const top = graph.nodes.filter((n) => !n.parent || !byId.has(n.parent)).map((n) => n.id);
  const topOf = new Map();
  const findTop = (id) => {
    if (topOf.has(id)) return topOf.get(id);
    const n = byId.get(id);
    const t = n && n.parent && byId.has(n.parent) ? findTop(n.parent) : id;
    topOf.set(id, t);
    return t;
  };
  for (const n of graph.nodes) findTop(n.id);
  const out = new Map();
  const inc = new Map();
  for (const e of graph.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    if (!inc.has(e.target)) inc.set(e.target, []);
    out.get(e.source).push(e);
    inc.get(e.target).push(e);
  }
  const called = new Set(graph.edges.filter((e) => e.kind === 'http').map((e) => e.target));
  const edgeCounts = {};
  for (const e of graph.edges) edgeCounts[e.kind] = (edgeCounts[e.kind] || 0) + 1;
  return { graph, byId, children, top, topOf, out, inc, called, edgeCounts };
}

export function descendants(M, id, acc = []) {
  for (const c of M.children.get(id) || []) {
    acc.push(c);
    descendants(M, c, acc);
  }
  return acc;
}

const basename = (p) => p.split('/').pop();
const parentDir = (p) => p.split('/').slice(-2, -1)[0] || '';

/** Short text drawn on a card. Paths go in the tooltip and the panel. */
export function labelOf(n) {
  switch (n.kind) {
    case 'file': {
      const name = basename(n.file);
      if (n.side === 'backend') return n.role === 'routes' ? `routes/${name}` : name.replace(/\.php$/, '');
      if (n.route && (n.nextKind === 'page' || n.nextKind === 'route' || n.nextKind === 'api')) return n.route === '/' ? '/ (root)' : n.route;
      if (n.nextKind && n.route) return `${n.nextKind} ${n.route}`;
      if (/^index\./.test(name)) return `${parentDir(n.file)}/${name}`;
      return name;
    }
    case 'endpoint':
    case 'unmatched':
      return n.path || n.name;
    case 'method':
      return n.name + '()';
    case 'function':
      return n.name.endsWith(')') ? n.name : n.name + '()';
    case 'closure':
      return `closure @${n.line}`;
    case 'interface':
    case 'trait':
    case 'enum':
      return `${n.kind} ${n.name}`;
    default:
      return n.name || n.id;
  }
}

/** [width, height, left tab width] of a card. */
export function sizeOf(n) {
  if (n.kind === 'file') return [176, 38, TAB_W];
  if (n.kind === 'endpoint' || n.kind === 'unmatched') return [244, 34, BADGE_W];
  return [166, 30, TAB_W];
}

/** Icon of a node (defs have their own; files and endpoints use their group's). */
export function iconOf(n, groupIcon) {
  if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait' || n.kind === 'enum') return 'class';
  if (n.kind === 'method' || n.kind === 'function') return 'method';
  if (n.kind === 'closure') return 'closure';
  return groupIcon;
}

/** Qualified name used in lists: Class::method, name — file, endpoint text, file path. */
export function displayName(M, id) {
  const n = M.byId.get(id);
  if (!n) return id;
  if (n.kind === 'file') return n.file;
  if (n.kind === 'method' && n.side === 'backend') return `${M.byId.get(n.parent)?.name ?? '?'}::${n.name}`;
  if (n.side === 'frontend' && n.kind !== 'file') return n.name;
  return n.name || id;
}

/** Location text: "path:line". */
export const locationOf = (n) => (n?.file ? n.file + (n.line ? ':' + n.line : '') : '');

export function editorUrl(n, meta) {
  if (!n || !n.file) return null;
  const root = n.side === 'backend' || n.server === 'laravel' ? meta.backendRoot : meta.frontendRoot;
  if (!root) return null;
  const abs = root.replace(/\/$/, '') + '/' + n.file;
  // vscode://file/<absolute path>:<line> — "/home/x" -> "vscode://file/home/x", "C:/x" -> "vscode://file/C:/x".
  const path = encodeURI(abs.startsWith('/') ? abs : '/' + abs).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return 'vscode://file' + path + ':' + (n.line || 1);
}

/** Does an endpoint pattern ("/api/users/*", "*?" optional, "**" catch-all) match concrete URL segments? */
export function patternMatches(pattern, segs) {
  const pat = pattern.split('/').filter(Boolean);
  const go = (pi, si) => {
    if (pi === pat.length) return si === segs.length;
    const p = pat[pi];
    if (p === '*?' || p === '**?') if (go(pi + 1, si)) return true;
    if (si >= segs.length) return false;
    if (p === '**' || p === '**?') return go(pi + 1, si + 1) || go(pi, si + 1);
    if (p === '*' || p === '*?' || p === segs[si] || (p.includes('*') && new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$').test(segs[si])))
      return go(pi + 1, si + 1);
    return false;
  };
  return go(0, 0);
}

/** Ranked search over names, paths, routes and (for URL-looking queries) endpoint patterns. */
export function search(M, q) {
  q = q.trim();
  if (!q) return [];
  const ql = q.toLowerCase();
  const urlPath = /^(https?:\/\/[^/]+)?\//i.test(q) ? q.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '') : null;
  const urlSegs = urlPath ? urlPath.split('/').filter(Boolean) : null;
  const results = [];
  for (const n of M.graph.nodes) {
    const name = (n.name || '').toLowerCase();
    let score = 0;
    if (name === ql) score = 100;
    else if (name.startsWith(ql)) score = 70;
    else if (name.includes(ql)) score = 50;
    else if ((n.path || '').toLowerCase().includes(ql) || (n.route || '').toLowerCase().includes(ql)) score = 45;
    else if ((n.file || '').toLowerCase().includes(ql)) score = 30;
    else if (n.id.toLowerCase().includes(ql)) score = 20;
    if (urlSegs && n.pattern && patternMatches(n.pattern, urlSegs)) score = Math.max(score, 90);
    if (!score) continue;
    if (n.kind === 'endpoint') score += 5;
    if (n.kind === 'file') score += 2;
    results.push({ n, score });
  }
  results.sort((a, b) => b.score - a.score || (a.n.name || '').localeCompare(b.n.name || ''));
  return results.slice(0, 40).map((r) => r.n);
}
