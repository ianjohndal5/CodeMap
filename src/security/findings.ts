import type { Graph, GraphNode } from '../types.js';
import type { Finding, ProtectionState } from './types.js';

/** Edge kinds that carry behaviour (as in the viewer's Chain focus); imports/uses are structure, not reach. */
const REACH_KINDS = new Set(['calls', 'handles', 'renders']);
const VISIT_CAP = 20000;
const ENDPOINT_CAP = 50;
const CALLER_CAP = 20;
/** Next.js files a user can land on. */
const ENTRY_KINDS = new Set(['page', 'layout', 'template', 'route', 'api', 'default', 'error', 'loading', 'not-found']);

/** Finds the graph node that contains a file position: the innermost definition whose line range covers it. */
export class Placer {
  private defs = new Map<string, GraphNode[]>();
  private files = new Map<string, string>();

  constructor(graph: Graph) {
    for (const n of graph.nodes) {
      if (!n.file || !n.side) continue;
      const key = `${n.side}:${n.file}`;
      if (n.kind === 'file') this.files.set(key, n.id);
      else if (n.line !== undefined && n.endLine !== undefined) {
        let list = this.defs.get(key);
        if (!list) this.defs.set(key, (list = []));
        list.push(n);
      }
    }
  }

  place(side: 'backend' | 'frontend', file: string, line?: number): string | null {
    const key = `${side}:${file}`;
    if (line !== undefined) {
      let best: GraphNode | null = null;
      for (const n of this.defs.get(key) ?? []) {
        if (n.line! <= line && line <= n.endLine! && (!best || n.endLine! - n.line! < best.endLine! - best.line!)) best = n;
      }
      if (best) return best.id;
    }
    return this.files.get(key) ?? null;
  }
}

/**
 * Context for findings: which endpoints reach a node through known (certain) edges, their
 * protection, the frontend code that calls them, and for frontend code the pages that use it.
 * Only "reachable via a known path" is ever stated; an empty list means "no known path".
 */
export class Reach {
  private inc = new Map<string, string[]>();
  private callers = new Map<string, Set<string>>();
  private byId: Map<string, GraphNode>;
  private cache = new Map<string, Pick<Finding, 'endpoints' | 'endpointCount' | 'callers' | 'entries' | 'path'>>();

  constructor(
    graph: Graph,
    private states: Map<string, ProtectionState>,
  ) {
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const e of graph.edges) {
      if (e.kind === 'http') {
        let s = this.callers.get(e.target);
        if (!s) this.callers.set(e.target, (s = new Set()));
        s.add(e.source);
      }
      if (!e.certain || !REACH_KINDS.has(e.kind)) continue;
      let list = this.inc.get(e.target);
      if (!list) this.inc.set(e.target, (list = []));
      list.push(e.source);
    }
  }

  /** Breadth-first walk backwards from `seeds`; returns parents (towards the seed) for path reconstruction. */
  private walk(seeds: string[]): Map<string, string | null> {
    const parent = new Map<string, string | null>(seeds.map((s) => [s, null]));
    const queue = [...seeds];
    for (let i = 0; i < queue.length && parent.size < VISIT_CAP; i++) {
      const id = queue[i];
      if (this.byId.get(id)?.kind === 'endpoint' && !seeds.includes(id)) continue;
      for (const src of this.inc.get(id) ?? []) {
        if (parent.has(src)) continue;
        parent.set(src, id);
        queue.push(src);
      }
    }
    return parent;
  }

  of(nodeId: string): Pick<Finding, 'endpoints' | 'endpointCount' | 'callers' | 'entries' | 'path'> {
    const cached = this.cache.get(nodeId);
    if (cached) return cached;
    const direct = this.walk([nodeId]);
    // A method is also "used" when its class is instantiated or called statically (edges that end on the class).
    const ancestors: string[] = [];
    for (let p = this.byId.get(nodeId)?.parent; p; p = this.byId.get(p)?.parent) if (this.byId.get(p)?.kind !== 'file') ancestors.push(p);
    const viaClass = ancestors.length ? this.walk(ancestors) : new Map<string, string | null>();
    const depth = (parent: Map<string, string | null>, id: string) => {
      let d = 0;
      for (let p = parent.get(id); p; p = parent.get(p)) d++;
      return d;
    };
    const endpoints: Finding['endpoints'] = [];
    // distance = edges on the path (one more for class-level use: the class, then the method inside it)
    for (const [id] of direct) if (this.byId.get(id)?.kind === 'endpoint') endpoints.push({ id, via: 'definition', distance: depth(direct, id) });
    for (const [id] of viaClass) {
      if (this.byId.get(id)?.kind === 'endpoint' && !direct.has(id)) endpoints.push({ id, via: 'class', distance: depth(viaClass, id) + 1 });
    }
    endpoints.sort((a, b) => (a.via === b.via ? 0 : a.via === 'definition' ? -1 : 1) || a.distance - b.distance || (a.id < b.id ? -1 : 1));
    for (const e of endpoints) {
      const s = this.states.get(e.id);
      if (s) e.state = s;
    }
    const callers = new Set<string>();
    for (const e of endpoints) for (const c of this.callers.get(e.id) ?? []) callers.add(c);
    // Frontend code: the Next.js pages, layouts and route handlers that reach it.
    const entries = new Set<string>();
    for (const [id] of direct) {
      const n = this.byId.get(id);
      if (n?.side !== 'frontend' || !n.file) continue;
      const file = this.byId.get(`fe:${n.file}`);
      if (file?.nextKind && ENTRY_KINDS.has(file.nextKind)) entries.add(file.id);
    }
    let path: string[] | undefined;
    const first = endpoints[0];
    if (first) {
      const parent = first.via === 'definition' ? direct : viaClass;
      path = [first.id];
      for (let p = parent.get(first.id); p; p = parent.get(p)) path.push(p);
      if (first.via === 'class') path.push(nodeId);
    }
    const out = {
      endpoints: endpoints.slice(0, ENDPOINT_CAP),
      endpointCount: endpoints.length,
      callers: [...callers].sort().slice(0, CALLER_CAP),
      entries: [...entries].sort(),
      ...(path ? { path } : {}),
    };
    this.cache.set(nodeId, out);
    return out;
  }
}
