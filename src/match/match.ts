import type { Endpoint } from '../types.js';
import { type CallSeg, type EndpointSeg, type NormalizedCall } from './url.js';

export interface PatternedEndpoint extends Endpoint {
  segs: EndpointSeg[];
}

interface SegScore {
  score: number;
  /** A comparison relied on a heuristic (mixed segments, wildcard vs literal). */
  fuzzy: boolean;
}

/** More matches than this for one call is noise, not a link: reported as ambiguous. */
export const MAX_MATCHES = 5;

/**
 * Compare one call segment with one endpoint segment (no optional/catch-all handling).
 * `strict` (static-suffix mode): a literal in the call must meet a literal in the route,
 * otherwise "${base}/session" would match every route ending in a parameter.
 */
function compare(c: CallSeg, e: EndpointSeg, strict: boolean): SegScore | null {
  if (e.k === 'lit') {
    if (c.k === 'lit') return c.v === e.v ? { score: 3, fuzzy: false } : null;
    if (c.k === 'wild') return { score: 0, fuzzy: true };
    return c.re.test(e.v) ? { score: 1, fuzzy: true } : null;
  }
  if (e.k === 'param' || e.k === 'catchall') {
    if (c.k === 'lit') return strict ? null : { score: 1, fuzzy: false };
    if (c.k === 'wild') return { score: 2, fuzzy: false };
    return { score: 1, fuzzy: true };
  }
  // e.k === 'mixed'
  if (c.k === 'lit') return e.re.test(c.v) ? { score: 2, fuzzy: false } : null;
  return { score: 0, fuzzy: true };
}

/**
 * Best score for matching all call segments against endpoint segments from
 * index `ei` on. Optional params may be skipped; catch-alls absorb 1+ (or 0+).
 */
function matchFrom(call: CallSeg[], ci: number, ep: EndpointSeg[], ei: number, strict = false): SegScore | null {
  if (ei === ep.length) return ci === call.length ? { score: 0, fuzzy: false } : null;
  const e = ep[ei];
  let best: SegScore | null = null;
  const consider = (r: SegScore | null) => {
    if (r && (!best || r.score > best.score || (r.score === best.score && !r.fuzzy && best.fuzzy))) best = r;
  };
  if ((e.k === 'param' || e.k === 'catchall') && e.optional) consider(matchFrom(call, ci, ep, ei + 1, strict));
  if (ci < call.length) {
    const here = compare(call[ci], e, strict);
    if (here) {
      if (e.k === 'catchall') {
        // Absorb this segment and either stop or keep absorbing.
        for (const next of [matchFrom(call, ci + 1, ep, ei + 1, strict), matchFrom(call, ci + 1, ep, ei, strict)]) {
          if (next) consider({ score: here.score + next.score, fuzzy: here.fuzzy || next.fuzzy });
        }
      } else {
        const next = matchFrom(call, ci + 1, ep, ei + 1, strict);
        if (next) consider({ score: here.score + next.score, fuzzy: here.fuzzy || next.fuzzy });
      }
    }
  }
  return best;
}

export function matchPath(call: CallSeg[], ep: EndpointSeg[], suffix: boolean): SegScore | null {
  if (!suffix) return matchFrom(call, 0, ep, 0);
  // Static-suffix match: the call may omit any number of leading endpoint segments.
  let best: SegScore | null = null;
  for (let start = 0; start < ep.length; start++) {
    const r = matchFrom(call, 0, ep, start, true);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best;
}

export function methodMatches(callMethod: string | null, ep: Endpoint): boolean {
  if (callMethod === null) return true;
  return ep.methods.includes('ANY') || ep.methods.includes(callMethod) || (callMethod === 'HEAD' && ep.methods.includes('GET'));
}

export interface MatchResult {
  endpoints: PatternedEndpoint[];
  /** More than MAX_MATCHES endpoints fit: not linked, reported as unmatched. */
  ambiguous?: boolean;
  certain: boolean;
  /** How the match was made: 'relative' (Laravel fallback for a relative URL), 'suffix', 'external'. */
  via?: string;
}

function bestMatches(call: NormalizedCall, method: string | null, eps: PatternedEndpoint[], suffix: boolean) {
  let bestScore = -1;
  let best: { ep: PatternedEndpoint; fuzzy: boolean }[] = [];
  for (const ep of eps) {
    if (!methodMatches(method, ep)) continue;
    const r = matchPath(call.segments, ep.segs, suffix);
    if (!r) continue;
    if (r.score > bestScore) {
      bestScore = r.score;
      best = [{ ep, fuzzy: r.fuzzy }];
    } else if (r.score === bestScore) best.push({ ep, fuzzy: r.fuzzy });
  }
  return best;
}

/** Apply the target-selection rules and return the matched endpoints with a certainty verdict. */
export function matchCall(
  call: NormalizedCall,
  method: string | null,
  laravel: PatternedEndpoint[],
  next: PatternedEndpoint[],
): MatchResult | null {
  const verdict = (found: { ep: PatternedEndpoint; fuzzy: boolean }[], baseCertain: boolean, via?: string): MatchResult => ({
    endpoints: found.map((f) => f.ep),
    ...(found.length > MAX_MATCHES ? { ambiguous: true } : {}),
    certain: baseCertain && method !== null && found.length === 1 && !found[0].fuzzy,
    via,
  });
  switch (call.target) {
    case 'backend': {
      const found = bestMatches(call, method, laravel, false);
      return found.length ? verdict(found, true) : null;
    }
    case 'relative': {
      const nx = bestMatches(call, method, next, false);
      if (nx.length) return verdict(nx, true);
      const lv = bestMatches(call, method, laravel, false);
      return lv.length ? verdict(lv, false, 'relative') : null;
    }
    case 'suffix': {
      const lv = bestMatches(call, method, laravel, true);
      if (lv.length) return verdict(lv, false, 'suffix');
      const nx = bestMatches(call, method, next, true);
      return nx.length ? verdict(nx, false, 'suffix') : null;
    }
    case 'external': {
      const lv = bestMatches(call, method, laravel, false);
      return lv.length ? verdict(lv, false, 'external') : null;
    }
  }
}
