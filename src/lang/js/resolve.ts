import fs from 'node:fs';
import path from 'node:path';
import type { TsPaths } from '../../detect.js';
import { dirnamePosix, joinPosix, normalizeRel } from '../../util/paths.js';

export type Resolution =
  | { kind: 'file'; rel: string }
  /** Bare package specifier (react, axios, next/link). */
  | { kind: 'external' }
  /** Non-code asset (css, svg, json, ...). */
  | { kind: 'asset' }
  /** Exists on disk but is not analyzed (dot-directory, .gitignore, exclude globs). */
  | { kind: 'excluded' }
  /** Looked like a project path (relative or alias) but no scanned file matched. */
  | { kind: 'unresolved' };

const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const JS_EXT_RE = /\.(m|c)?jsx?$/;
const ASSET_RE = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|json|md|mdx|txt|html|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|glsl|graphql|gql|ya?ml)(\?.*)?$/i;

/** Resolves import specifiers to scanned files, following tsconfig/jsconfig baseUrl + paths. */
export class ModuleResolver {
  private paths: { prefix: string; suffix: string; wildcard: boolean; targets: string[] }[];
  private cache = new Map<string, Resolution>();

  /** `root` (the project directory) is only used to tell excluded files from missing ones. */
  constructor(
    private files: Set<string>,
    private ts: TsPaths,
    private root: string | null = null,
  ) {
    this.paths = ts.paths
      .map(({ pattern, targets }) => {
        const star = pattern.indexOf('*');
        return star < 0
          ? { prefix: pattern, suffix: '', wildcard: false, targets }
          : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), wildcard: true, targets };
      })
      // TypeScript prefers the pattern with the longest prefix.
      .sort((a, b) => b.prefix.length - a.prefix.length);
  }

  resolve(fromRel: string, spec: string): Resolution {
    const key = `${dirnamePosix(fromRel)}\u0000${spec}`;
    let r = this.cache.get(key);
    if (!r) {
      r = this.compute(fromRel, spec);
      this.cache.set(key, r);
    }
    return r;
  }

  private compute(fromRel: string, spec: string): Resolution {
    const isAsset = ASSET_RE.test(spec);
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const base = normalizeRel(joinPosix(dirnamePosix(fromRel), spec));
      // Climbs out of the project (e.g. into a monorepo's packages/): outside the analysis, like a package.
      if (base === null) return { kind: 'external' };
      const hit = this.tryFile(base);
      return hit ? { kind: 'file', rel: hit } : isAsset ? { kind: 'asset' } : this.miss(base);
    }
    if (spec.startsWith('/')) {
      const hit = this.tryFile(spec.slice(1));
      return hit ? { kind: 'file', rel: hit } : isAsset ? { kind: 'asset' } : this.miss(spec.slice(1));
    }
    for (const p of this.paths) {
      let captured: string | null = null;
      if (p.wildcard) {
        if (spec.startsWith(p.prefix) && spec.endsWith(p.suffix) && spec.length >= p.prefix.length + p.suffix.length) {
          captured = spec.slice(p.prefix.length, spec.length - p.suffix.length);
        }
      } else if (spec === p.prefix) captured = '';
      if (captured === null) continue;
      let first: string | null = null;
      for (const t of p.targets) {
        const target = normalizeRel(joinPosix(this.ts.baseDir, t.replace('*', captured)));
        first ??= target;
        const hit = target === null ? null : this.tryFile(target);
        if (hit) return { kind: 'file', rel: hit };
      }
      return isAsset ? { kind: 'asset' } : first === null ? { kind: 'unresolved' } : this.miss(first);
    }
    if (this.ts.hasBaseUrl) {
      const target = normalizeRel(joinPosix(this.ts.baseDir, spec));
      const hit = target === null ? null : this.tryFile(target);
      if (hit) return { kind: 'file', rel: hit };
    }
    return isAsset ? { kind: 'asset' } : { kind: 'external' };
  }

  /** Not among the scanned files: excluded if something matching exists on disk, else unresolved. */
  private miss(base: string): Resolution {
    if (this.root) {
      const abs = path.join(this.root, base);
      const candidates = [abs, ...CODE_EXTS.map((e) => abs + e), ...CODE_EXTS.map((e) => path.join(abs, 'index' + e))];
      if (JS_EXT_RE.test(abs)) candidates.push(...['.ts', '.tsx'].map((e) => abs.replace(JS_EXT_RE, e)));
      if (candidates.some((c) => fs.existsSync(c))) return { kind: 'excluded' };
    }
    return { kind: 'unresolved' };
  }

  private tryFile(base: string): string | null {
    const f = this.files;
    if (f.has(base)) return base;
    // TS ESM style: "./foo.js" refers to foo.ts.
    if (JS_EXT_RE.test(base)) {
      const stem = base.replace(JS_EXT_RE, '');
      for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (f.has(stem + ext)) return stem + ext;
    }
    for (const ext of CODE_EXTS) if (f.has(base + ext)) return base + ext;
    for (const ext of CODE_EXTS) {
      const idx = base === '' ? `index${ext}` : `${base}/index${ext}`;
      if (f.has(idx)) return idx;
    }
    return null;
  }
}
