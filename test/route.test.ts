import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module from the viewer (no type declarations)
import { computeRoutes, routeStyle } from '../viewer/route.js';

type Box = { x1: number; y1: number; x2: number; y2: number; top: string; ancestors: string[] };
type Route = { sx: number; sy: number; tx: number; ty: number; pts: number[][] };

/** A top-level card: 100 wide, 20 high. */
const card = (x: number, y: number): Box & { id?: string } => ({ x1: x, x2: x + 100, y1: y, y2: y + 20, top: '', ancestors: [] });

function boxesOf(cards: Record<string, Box>): Map<string, Box> {
  return new Map(Object.entries(cards).map(([id, b]) => [id, { ...b, top: b.top || id }]));
}

const run = (cards: Record<string, Box>, edges: [string, string][]) => {
  const { routes, widen } = computeRoutes(
    boxesOf(cards),
    edges.map(([s, t]) => ({ id: `${s}>${t}`, s, t })),
  );
  return { r: (s: string, t: string) => routes.get(`${s}>${t}`) as Route, routes: routes as Map<string, Route>, widen: widen as { at: number; by: number }[] };
};

describe('edge routing', () => {
  it('brackets edges within a column: up on the left, down on the right, outside the cards', () => {
    const { r } = run({ a: card(0, 0), b: card(0, 100) }, [
      ['b', 'a'],
      ['a', 'b'],
    ]);
    const up = r('b', 'a');
    expect([up.sx, up.tx]).toEqual([0, 0]); // both ends on the left side
    expect(up.pts.map(([x]) => x)).toEqual([-10, -10]); // the vertical run is left of the column
    const down = r('a', 'b');
    expect([down.sx, down.tx]).toEqual([100, 100]);
    expect(down.pts.map(([x]) => x)).toEqual([110, 110]);
  });

  it('nests brackets: the longer one runs outside, and leaves its card below the shorter one', () => {
    const { r } = run({ far: card(0, 0), near: card(0, 100), src: card(0, 200) }, [
      ['src', 'near'],
      ['src', 'far'],
    ]);
    const inner = r('src', 'near');
    const outer = r('src', 'far');
    expect(outer.pts[0][0]).toBeLessThan(inner.pts[0][0]);
    expect(outer.sy).toBeGreaterThan(inner.sy); // no stub crosses the other's vertical run
  });

  it('turns edges between columns in the channel next to the target, entering from the facing side', () => {
    const { r } = run({ model: card(0, 0), page: card(400, 100) }, [['page', 'model']]);
    const e = r('page', 'model');
    expect(e.sx).toBe(400); // leaves the page on its left side
    expect(e.tx).toBe(100); // enters the model on its right side
    expect(e.pts).toEqual([
      [110, e.sy],
      [110, e.ty],
    ]);
  });

  it('lets edges arriving from one direction share one arrowhead, but spreads the ends that leave', () => {
    const { r } = run({ t: card(0, 0), a: card(0, 100), b: card(0, 200) }, [
      ['a', 't'],
      ['b', 't'],
    ]);
    expect(r('a', 't').ty).toBe(r('b', 't').ty);
    const { r: r2 } = run({ s: card(0, 200), a: card(0, 0), b: card(0, 100) }, [
      ['s', 'a'],
      ['s', 'b'],
    ]);
    expect(r2('s', 'a').sy).not.toBe(r2('s', 'b').sy);
  });

  it('keeps level edges between columns straight', () => {
    const { r } = run({ a: card(0, 0), b: card(400, 0) }, [['b', 'a']]);
    expect(r('b', 'a').pts).toEqual([]);
    expect(r('b', 'a').sy).toBe(r('b', 'a').ty);
  });

  it('asks for a wider channel when its tracks do not fit', () => {
    const cards: Record<string, Box> = { t: card(0, 0) };
    const edges: [string, string][] = [];
    for (let i = 0; i < 6; i++) {
      cards[`s${i}`] = card(130, 40 * i);
      edges.push([`s${i}`, 't']);
    }
    const { widen } = run(cards, edges);
    // s0 is level with t (a straight edge), so 5 tracks: 2 margins + 4 steps, in a 30px channel.
    expect(widen).toEqual([{ at: 130, by: 2 * 10 + 4 * 10 - 30 }]);

  });

  it('leaves edges between a card and the frame around it to Cytoscape (it draws them as compound loops)', () => {
    const nested = boxesOf({ cls: { ...card(0, 0), x2: 120, y2: 100 }, fn: { ...card(10, 30), top: 'cls', ancestors: ['cls'] } });
    expect(computeRoutes(nested, [{ id: 'x', s: 'fn', t: 'cls' }]).routes.size).toBe(0);
  });

  it('turns a route into Cytoscape endpoints and segment weights/distances that give the same points back', () => {
    const route: Route = { sx: 400, sy: 108, tx: 100, ty: 4, pts: [
      [110, 108],
      [110, 4],
    ] };
    const sp = { x: 450, y: 110 };
    const tp = { x: 50, y: 10 };
    const st = routeStyle(route, sp, tp);
    expect(st.rse).toBe('-50px -2px');
    expect(st.rte).toBe('50px -6px');
    // Cytoscape (`edge-distances: endpoints`): P = S + w * (T - S) + d * normal, normal = (-dy, dx) / length.
    const [vx, vy] = [route.tx - route.sx, route.ty - route.sy];
    const l = Math.hypot(vx, vy);
    const back = st.rw.map((w: number, i: number) => [route.sx + w * vx + st.rd[i] * (-vy / l), route.sy + w * vy + st.rd[i] * (vx / l)]);
    back.forEach(([x, y]: number[], i: number) => {
      expect(x).toBeCloseTo(route.pts[i][0], 6);
      expect(y).toBeCloseTo(route.pts[i][1], 6);
    });
    expect(routeStyle({ ...route, pts: [] }, sp, tp).straight).toBe(true);
  });
});
