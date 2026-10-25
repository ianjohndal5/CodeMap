import type { Diagnostic, Graph, GraphEdge, GraphNode, Side } from './types.js';

/** Per reason, so frequent reasons (untyped calls) cannot crowd out rare ones (missing route controllers). */
const DIAGNOSTIC_CAP_PER_REASON = 250;

/** Accumulates nodes and edges from both adapters and emits a deterministic graph. */
/** `node` with `endLine` right after `line`. Called only when ranges are on, so the flag-off path builds plain literals. */
export function withEndLine(node: GraphNode, endLine: number | undefined): GraphNode {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = v;
    if (k === 'line') out.endLine = endLine;
  }
  return out as unknown as GraphNode;
}

export class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  readonly diagnostics: Diagnostic[] = [];
  diagnosticsDropped = 0;
  private perReason = new Map<string, number>();

  /** Adapters add definition end lines (`endLine`) only when set: off by default so graph.json is unchanged. */
  constructor(readonly options: { ranges?: boolean } = {}) {}

  get ranges(): boolean {
    return Boolean(this.options.ranges);
  }

  addNode(node: GraphNode): void {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Merge edges with the same source, target, kind, certainty and sub-kind; self-loops are dropped. */
  addEdge(edge: GraphEdge): void {
    if (edge.source === edge.target) return;
    const key = `${edge.source}\u0001${edge.target}\u0001${edge.kind}\u0001${edge.certain}\u0001${edge.via ?? ''}`;
    const existing = this.edges.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      if (edge.line !== undefined && (existing.line === undefined || edge.line < existing.line)) existing.line = edge.line;
      return;
    }
    this.edges.set(key, { ...edge });
  }

  diagnose(side: Side, file: string, reason: string, line?: number, text?: string): void {
    const n = (this.perReason.get(reason) ?? 0) + 1;
    this.perReason.set(reason, n);
    if (n > DIAGNOSTIC_CAP_PER_REASON) {
      this.diagnosticsDropped++;
      return;
    }
    this.diagnostics.push({ side, file, line, text, reason });
  }

  edgeList(): GraphEdge[] {
    return [...this.edges.values()];
  }

  /** Nodes and edges sorted so the same input always produces byte-identical JSON (apart from meta). */
  sorted(): Pick<Graph, 'nodes' | 'edges'> {
    const nodes = [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // An edge to a node that was never emitted (e.g. a file that failed to analyze) would break the viewer.
    const dangling = this.edgeList().filter((e) => !this.nodes.has(e.source) || !this.nodes.has(e.target));
    for (const e of dangling) {
      this.edges.delete(`${e.source}\u0001${e.target}\u0001${e.kind}\u0001${e.certain}\u0001${e.via ?? ''}`);
      this.diagnose(e.source.startsWith('be:') ? 'backend' : 'frontend', '', 'dropped edge to unknown node', e.line, `${e.source} -> ${e.target}`);
    }
    const edges = this.edgeList().sort(
      (a, b) =>
        cmp(a.source, b.source) ||
        cmp(a.target, b.target) ||
        cmp(a.kind, b.kind) ||
        Number(b.certain) - Number(a.certain) ||
        cmp(a.via ?? '', b.via ?? ''),
    );
    for (const e of edges) if (e.count === 1) delete e.count;
    return { nodes, edges };
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
