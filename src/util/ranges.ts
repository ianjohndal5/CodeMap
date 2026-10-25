/** A [start, end) span; spans in one index must be nested or disjoint (like syntax nodes). */
export interface Span {
  start: number;
  end: number;
}

/**
 * Finds the innermost span containing an offset in O(log n + depth).
 * Used to attribute query captures (calls, JSX) to their enclosing definition.
 */
export class SpanIndex<T extends Span> {
  private spans: T[];
  private parent: number[];

  constructor(spans: T[]) {
    this.spans = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
    this.parent = new Array(this.spans.length).fill(-1);
    const stack: number[] = [];
    this.spans.forEach((s, i) => {
      while (stack.length && this.spans[stack[stack.length - 1]].end <= s.start) stack.pop();
      if (stack.length) this.parent[i] = stack[stack.length - 1];
      stack.push(i);
    });
  }

  innermost(pos: number): T | null {
    let lo = 0;
    let hi = this.spans.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.spans[mid].start <= pos) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    while (i >= 0 && this.spans[i].end <= pos) i = this.parent[i];
    return i >= 0 ? this.spans[i] : null;
  }
}
