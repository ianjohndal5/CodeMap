import type { UrlPart } from '../types.js';

// ---------------------------------------------------------------------------
// Endpoint side: route definitions -> segment patterns.

export type EndpointSeg =
  | { k: 'lit'; v: string }
  /** Single-segment parameter: Laravel {id} / {id?}, Next.js [id]. */
  | { k: 'param'; optional: boolean }
  /** Next.js [...slug] (one or more segments) / [[...slug]] (zero or more). */
  | { k: 'catchall'; optional: boolean }
  /** Literal text mixed with a parameter, e.g. "user-{id}". */
  | { k: 'mixed'; re: RegExp; src: string };

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Laravel URI ("/api/users/{user}/posts/{post?}") -> segments. */
export function laravelPattern(uri: string): EndpointSeg[] {
  return splitPath(uri).map((seg): EndpointSeg => {
    const whole = /^\{(\w+)(\?)?\}$/.exec(seg);
    if (whole) return { k: 'param', optional: Boolean(whole[2]) };
    if (seg.includes('{')) {
      const re = new RegExp('^' + seg.split(/\{\w+\??\}/).map(escapeRe).join('[^/]+') + '$');
      return { k: 'mixed', re, src: seg.replace(/\{\w+\??\}/g, '*') };
    }
    return { k: 'lit', v: seg };
  });
}

/** Next.js route ("/api/users/[id]", "/docs/[[...slug]]") -> segments. Route groups must already be removed. */
export function nextPattern(route: string): EndpointSeg[] {
  return splitPath(route).map((seg): EndpointSeg => {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) return { k: 'catchall', optional: true };
    if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return { k: 'catchall', optional: false };
    if (/^\[[^\]]+\]$/.test(seg)) return { k: 'param', optional: false };
    if (seg.includes('[')) {
      const re = new RegExp('^' + seg.split(/\[[^\]]+\]/).map(escapeRe).join('[^/]+') + '$');
      return { k: 'mixed', re, src: seg.replace(/\[[^\]]+\]/g, '*') };
    }
    return { k: 'lit', v: seg };
  });
}

/** Stable textual key used in endpoint ids: params become "*", optional "*?", catch-alls "**" / "**?". */
export function patternKey(segs: EndpointSeg[]): string {
  const parts = segs.map((s) => {
    switch (s.k) {
      case 'lit':
        return s.v;
      case 'param':
        return s.optional ? '*?' : '*';
      case 'catchall':
        return s.optional ? '**?' : '**';
      case 'mixed':
        return s.src;
    }
  });
  return '/' + parts.join('/');
}

// ---------------------------------------------------------------------------
// Call side: URL expressions -> classified segment lists.

export type CallSeg =
  | { k: 'lit'; v: string }
  /** Whole segment comes from an interpolation. */
  | { k: 'wild' }
  /** Literal text mixed with interpolations; `loose` when a trailing interpolation may be a query string. */
  | { k: 'mixed'; re: RegExp; src: string; loose: boolean };

/**
 * Where a call should be matched:
 * - backend:  env/base-URL prefix or absolute URL to a known backend host -> Laravel, certain.
 * - relative: "/api/..." -> Next.js route handlers first, then Laravel (uncertain).
 * - suffix:   unknown leading interpolation -> static suffix match, uncertain.
 * - external: absolute URL to another host -> Laravel, uncertain.
 */
export type CallTarget = 'backend' | 'relative' | 'suffix' | 'external';

export interface NormalizedCall {
  target: CallTarget;
  segments: CallSeg[];
  /** Human-readable normalized path, interpolations shown as "*". */
  display: string;
}

export interface NormalizeOptions {
  /** If non-empty, only these env vars count as the backend base URL. */
  backendEnvVars: string[];
  backendHosts: string[];
  /**
   * Path the backend base URL carries (e.g. "/api" when NEXT_PUBLIC_API_URL ends in /api):
   * one path for every env/base variable, or per variable name. Wins over a path inferred
   * from a literal fallback in code.
   */
  backendBasePath?: string | Record<string, string>;
  /** Base paths inferred from literal fallbacks elsewhere in the project, per env var (set by the link stage). */
  inferredBasePaths?: Map<string, string>;
}

/** Base path for a call whose URL starts with env var / base variable `name`: config, then this call's fallback, then the project's. */
function basePathFor(name: string, inferred: string | undefined, opts: NormalizeOptions): string {
  const cfg = opts.backendBasePath;
  if (typeof cfg === 'object' && cfg[name] !== undefined) return cfg[name];
  if (inferred !== undefined) return inferred;
  const projectWide = opts.inferredBasePaths?.get(name);
  if (projectWide !== undefined) return projectWide;
  return typeof cfg === 'string' ? cfg : '';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
const HOLE = '\u0000';

/** Put a base path ("/api") in front of the rest of a URL that starts at the backend base. */
function withBasePath(basePath: string, rest: UrlPart[]): UrlPart[] {
  const clean = basePath.replace(/^\/*/, '/').replace(/\/+$/, '');
  return clean && clean !== '/' ? [{ t: 'lit', v: clean + '/' }, ...rest] : rest;
}

/**
 * Normalize URL parts (after constant resolution) into a matchable form, or
 * return null when nothing static is left to match on.
 */
export function normalizeCallUrl(parts: UrlPart[], opts: NormalizeOptions): NormalizedCall | null {
  const p = parts.filter((x) => !(x.t === 'lit' && x.v === ''));
  if (p.length === 0) return null;
  let target: CallTarget;
  let rest: UrlPart[];
  const first = p[0];

  if (first.t === 'env') {
    const isBackend = opts.backendEnvVars.length === 0 || opts.backendEnvVars.includes(first.name);
    target = isBackend ? 'backend' : 'suffix';
    rest = p.slice(1);
    if (isBackend) rest = withBasePath(basePathFor(first.name, first.basePath, opts), rest);
  } else if (first.t === 'base') {
    target = 'backend';
    rest = withBasePath(basePathFor(first.name, undefined, opts), p.slice(1));
  } else if (first.t !== 'lit') {
    target = 'suffix';
    rest = p.slice(1);
  } else {
    const abs = /^([a-z][a-z0-9+.-]*:)?\/\//i.exec(first.v);
    if (abs) {
      // Absolute URL: the host must be fully literal to know where it points.
      const afterScheme = first.v.slice(abs[0].length);
      const slash = afterScheme.search(/[/?#]/);
      if (slash < 0 && p.length > 1) {
        // Host continues into an interpolation: unknown host.
        target = 'suffix';
        rest = p.slice(1);
      } else {
        const host = (slash < 0 ? afterScheme : afterScheme.slice(0, slash)).toLowerCase();
        const hostname = host.replace(/:\d+$/, '');
        const known = LOCAL_HOSTS.has(hostname) || opts.backendHosts.some((h) => h.toLowerCase() === host || h.toLowerCase() === hostname);
        target = known ? 'backend' : 'external';
        rest = [{ t: 'lit', v: slash < 0 ? '' : afterScheme.slice(slash) }, ...p.slice(1)];
      }
    } else {
      target = 'relative';
      rest = p;
    }
  }

  // Concatenate into a path string where every interpolation is one HOLE char.
  let path = '';
  for (const part of rest) {
    if (part.t === 'lit') {
      const cut = part.v.search(/[?#]/);
      if (cut >= 0) {
        path += part.v.slice(0, cut);
        break; // query string / fragment: everything after is irrelevant
      }
      path += part.v;
    } else path += HOLE;
  }
  const rawSegs = path.split('/').filter((s) => s !== '');
  if (rawSegs.length === 0) {
    // "${API}" or "${API}/" alone: the base itself. Only meaningful for literal roots.
    if (target === 'suffix') return null;
  }
  const segments: CallSeg[] = rawSegs.map((seg, i): CallSeg => {
    if (!seg.includes(HOLE)) return { k: 'lit', v: seg };
    if (/^\u0000+$/.test(seg)) return { k: 'wild' };
    const isLast = i === rawSegs.length - 1;
    // "users${query}" at the end: the interpolation is probably a query string.
    const loose = isLast && seg.endsWith(HOLE) && !seg.startsWith(HOLE);
    const body = seg
      .split(/\u0000+/)
      .map(escapeRe)
      .join(loose ? '.*' : '[^/]+');
    return { k: 'mixed', re: new RegExp('^' + body + '$'), src: seg.replace(/\u0000+/g, '*'), loose };
  });
  if (target === 'suffix' && !segments.some((s) => s.k === 'lit' || s.k === 'mixed')) return null;
  const display =
    (target === 'suffix' ? '…' : '') +
    '/' +
    segments.map((s) => (s.k === 'lit' ? s.v : s.k === 'wild' ? '*' : s.src)).join('/');
  return { target, segments, display };
}
