// Orthogonal edge routes for the flow layout. Cards stand in columns (one per role band), so a
// straight line between two cards of the same column runs through every card between them, and
// edges into one column pile up on top of each other. Here every edge leaves its card from the
// side, runs vertically in the free channel between two columns on a track of its own, and enters
// its target from the side:
//
//   * between columns: out of the side facing the target, along a track in the channel next to
//     the target's column, into the target's facing side;
//   * within a column: a bracket around the column, on the left for edges going up and on the
//     right for edges going down; shorter brackets nest inside longer ones.
//
// Edges between a card and the frame around it (a method and its class) are left alone: Cytoscape
// always draws those as its own compound loop, whatever the curve style.
//
// Edge ends leaving a card are spread along its side so stubs do not cross the vertical runs next to
// them; edges arriving at one side from the same direction share one end, so they meet in a single
// arrowhead. Pure geometry: boxes in, absolute points out (routeStyle turns them into Cytoscape styles).

/** Distance from a column to its first track, and between tracks (squeezed down to MIN_STEP in narrow channels). */
const MARGIN = 10;
const STEP = 10;
const MIN_STEP = 3;
/** Columns move apart for at most this many tracks per channel; more tracks squeeze closer instead. */
const MAX_WIDEN_TRACKS = 24;
/** Vertical clearance between two runs on one track. */
const PAD = 6;
/** Share of a card's height used to spread several edge ends on one side. */
const SPREAD = 0.8;

/**
 * @param {Map<string, {x1:number, y1:number, x2:number, y2:number, top:string, ancestors:string[]}>} boxes
 *   cards by id; `top` is the top-level card (itself for top-level cards)
 * @param {{id:string, s:string, t:string}[]} edges
 * @returns {{ routes: Map<string, {sx:number, sy:number, tx:number, ty:number, pts:number[][]}>, widen: {at:number, by:number}[] }}
 *   endpoints and corner points per edge (no corners for a straight horizontal edge), and the channels
 *   too narrow for their tracks: everything from `at` rightwards should move `by` to the right
 */
export function computeRoutes(boxes, edges) {
  const columns = columnsOf(boxes);
  // A card's column is its top-level card's (the column ranges were merged from those).
  const columnOf = (b) => columns.findIndex((c) => boxes.get(b.top).x1 >= c.x1 && boxes.get(b.top).x2 <= c.x2);
  const midY = (b) => (b.y1 + b.y2) / 2;

  // Where each edge goes: sides, channel and the channel end its column sits on.
  const plans = [];
  for (const e of edges) {
    const s = boxes.get(e.s);
    const t = boxes.get(e.t);
    if (!s || !t || e.s === e.t || s.ancestors.includes(e.t) || t.ancestors.includes(e.s)) continue;
    const cs = columnOf(s);
    const ct = columnOf(t);
    if (cs < 0 || ct < 0) continue;
    const sy = midY(s);
    const ty = midY(t);
    let plan;
    if (cs === ct) {
      const up = ty < sy;
      plan = up ? { sSide: 'left', tSide: 'left', channel: cs, anchor: 'right' } : { sSide: 'right', tSide: 'right', channel: cs + 1, anchor: 'left' };
    } else if (cs < ct) plan = { sSide: 'right', tSide: 'left', channel: ct, anchor: 'right' };
    else plan = { sSide: 'left', tSide: 'right', channel: ct + 1, anchor: 'left' };
    plan.straight = cs !== ct && Math.abs(sy - ty) < 4;
    plans.push({ e, s, t, sy, ty, lo: Math.min(sy, ty), hi: Math.max(sy, ty), ...plan });
  }

  // Tracks: per channel end, shortest runs first, each on the first track it fits (nested brackets).
  const pools = new Map();
  for (const p of plans) {
    if (p.straight) continue;
    const key = `${p.channel}:${p.anchor}`;
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(p);
  }
  const trackCount = new Map();
  for (const [key, list] of pools) {
    list.sort((a, b) => a.hi - a.lo - (b.hi - b.lo) || a.lo - b.lo || (a.e.id < b.e.id ? -1 : 1));
    const tracks = [];
    for (const p of list) {
      let k = tracks.findIndex((runs) => runs.every((r) => p.lo >= r.hi + PAD || p.hi <= r.lo - PAD));
      if (k < 0) k = tracks.push([]) - 1;
      tracks[k].push(p);
      p.track = k;
    }
    trackCount.set(key, tracks.length);
  }
  const bounds = (i) => ({ left: i > 0 ? columns[i - 1].x2 : -Infinity, right: i < columns.length ? columns[i].x1 : Infinity });
  const tracksIn = (i) => (trackCount.get(`${i}:left`) ?? 0) + (trackCount.get(`${i}:right`) ?? 0);
  for (const p of plans) {
    if (p.straight) continue;
    const { left, right } = bounds(p.channel);
    const step = Number.isFinite(left) && Number.isFinite(right) ? Math.max(MIN_STEP, Math.min(STEP, (right - left - 2 * MARGIN) / Math.max(1, tracksIn(p.channel) - 1))) : STEP;
    p.x = p.anchor === 'right' ? right - MARGIN - p.track * step : left + MARGIN + p.track * step;
  }
  const widen = [];
  for (let i = 1; i < columns.length; i++) {
    const need = tracksIn(i) ? 2 * MARGIN + Math.min(tracksIn(i) - 1, MAX_WIDEN_TRACKS) * STEP : 0;
    const { left, right } = bounds(i);
    if (need > right - left) widen.push({ at: right, by: need - (right - left) });
  }

  // Spread the ends on each card side: going up first (innermost track on top), then level, then
  // going down (outermost on top), so no stub crosses a neighbour's vertical run. Arriving ends from
  // one direction are one slot: their lines join and end in a single arrowhead.
  const sideX = (b, side) => (side === 'left' ? b.x1 : b.x2);
  const ends = new Map();
  const addEnd = (b, id, side, dir, dist, set, arrives) => {
    const key = `${id}|${side}`;
    if (!ends.has(key)) ends.set(key, { b, list: [] });
    const list = ends.get(key).list;
    const shared = arrives && list.find((x) => x.arrives && x.dir === dir);
    if (shared) {
      shared.sets.push(set);
      shared.dist = Math.min(shared.dist, dist);
    } else list.push({ dir, dist, sets: [set], arrives });
  };
  for (const p of plans) {
    const sx = sideX(p.s, p.sSide);
    const tx = sideX(p.t, p.tSide);
    const sDir = p.straight ? 'flat' : p.ty < p.sy ? 'up' : 'down';
    const tDir = p.straight ? 'flat' : p.sy < p.ty ? 'up' : 'down';
    p.route = { sx, sy: p.sy, tx, ty: p.ty, pts: [] };
    addEnd(p.s, p.e.s, p.sSide, sDir, p.straight ? 0 : Math.abs(p.x - sx), (y) => (p.route.sy = y), false);
    addEnd(p.t, p.e.t, p.tSide, tDir, p.straight ? 0 : Math.abs(p.x - tx), (y) => (p.route.ty = y), true);
  }
  const rank = { up: 0, flat: 1, down: 2 };
  for (const { b, list } of ends.values()) {
    list.sort((a, c) => rank[a.dir] - rank[c.dir] || (a.dir === 'down' ? c.dist - a.dist : a.dist - c.dist));
    const span = (b.y2 - b.y1) * SPREAD;
    list.forEach((end, i) => {
      const y = midY(b) + (list.length === 1 ? 0 : -span / 2 + (span * i) / (list.length - 1));
      for (const set of end.sets) set(y);
    });
  }

  const out = new Map();
  for (const p of plans) {
    const r = p.route;
    if (p.straight) r.ty = r.sy = (r.sy + r.ty) / 2;
    else r.pts = [
      [p.x, r.sy],
      [p.x, r.ty],
    ];
    out.set(p.e.id, r);
  }
  return { routes: out, widen };
}

/** Columns: the x ranges of top-level cards, merged where they overlap. */
function columnsOf(boxes) {
  const tops = [...boxes.entries()].filter(([id, b]) => b.top === id).map(([, b]) => b);
  tops.sort((a, b) => a.x1 - b.x1);
  const cols = [];
  for (const b of tops) {
    const last = cols[cols.length - 1];
    if (last && b.x1 < last.x2) last.x2 = Math.max(last.x2, b.x2);
    else cols.push({ x1: b.x1, x2: b.x2 });
  }
  return cols;
}

/**
 * Cytoscape form of a route: manual endpoints relative to each node's position, and corner points as
 * weights along / distances across the line between the endpoints (`edge-distances: endpoints`).
 */
export function routeStyle(route, sourcePos, targetPos) {
  const { sx, sy, tx, ty, pts } = route;
  const data = { rse: `${sx - sourcePos.x}px ${sy - sourcePos.y}px`, rte: `${tx - targetPos.x}px ${ty - targetPos.y}px` };
  const vx = tx - sx;
  const vy = ty - sy;
  const l2 = vx * vx + vy * vy;
  if (!pts.length || l2 < 1) return { ...data, straight: true };
  const l = Math.sqrt(l2);
  return {
    ...data,
    rw: pts.map(([x, y]) => ((x - sx) * vx + (y - sy) * vy) / l2),
    rd: pts.map(([x, y]) => ((x - sx) * -vy + (y - sy) * vx) / l),
  };
}
