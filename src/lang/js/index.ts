import path from 'node:path';
import { type Adapter, countReason, emptyStats } from '../../adapter.js';
import type { CodemapConfig } from '../../config.js';
import { readTsPaths } from '../../detect.js';
import { withEndLine, type GraphBuilder } from '../../graph.js';
import { nextPattern, patternKey } from '../../match/url.js';
import { type ParsedFile, parseFile } from '../../parse.js';
import { scanNext } from '../../scan.js';
import type { Endpoint, GraphNode, HttpCall, UrlPart } from '../../types.js';
import { extractJs, type JsFileInfo, type TopBinding } from './extract.js';
import { nextFileInfo, ROUTE_HANDLER_METHODS } from './next.js';
import { ModuleResolver } from './resolve.js';

export const feFileId = (rel: string) => `fe:${rel}`;
export const feDefId = (rel: string, key: string) => `fe:${rel}#${key}`;

/** What an imported or local name ultimately refers to. */
export type Target =
  | { kind: 'def'; file: string; key: string }
  | { kind: 'object'; file: string; binding: Extract<TopBinding, { kind: 'object' }> }
  | { kind: 'instance'; file: string; base: UrlPart[][] | null }
  | { kind: 'url'; file: string; parts: UrlPart[][] }
  | { kind: 'namespace'; file: string }
  /** A project value that is not a syntactic definition (factory result, destructured export). */
  | { kind: 'value'; file: string; name: string }
  /** Resolved into a project file, but the export was not found there. */
  | { kind: 'missing'; file: string; name: string };

const MAX_DEPTH = 12;

export class NextAdapter implements Adapter {
  readonly side = 'frontend' as const;
  readonly endpoints: Endpoint[] = [];
  readonly httpCalls: HttpCall[] = [];
  readonly stats = emptyStats();
  files: string[] = [];
  parsed = new Map<string, ParsedFile>();
  infos = new Map<string, JsFileInfo>();
  private resolver!: ModuleResolver;

  /** `keepSyntax`: keep definition nodes and scopes after extraction (needed by the security lens). */
  constructor(
    readonly root: string,
    private config: CodemapConfig,
    private warnings: string[],
    private options: { keepSyntax?: boolean } = {},
  ) {}

  scan(): void {
    this.files = scanNext(this.root, this.config);
  }

  parse(): void {
    let minified = 0;
    for (const rel of this.files) {
      const r = parseFile(this.root, rel);
      if (r.ok) {
        this.parsed.set(rel, r.file);
        if (r.file.hasError) this.stats.parseErrors++;
      } else if (r.skipped) {
        if (r.reason === 'minified') minified++;
        else this.warnings.push(`frontend: skipped ${rel} (${r.reason})`);
      } else {
        this.stats.parseErrors++;
        this.warnings.push(`frontend: skipped ${rel} (${r.reason})`);
      }
    }
    if (minified) this.warnings.push(`frontend: skipped ${minified} minified file(s)`);
    this.stats.files = this.parsed.size;
  }

  extract(): void {
    for (const [rel, f] of this.parsed) {
      try {
        this.infos.set(rel, extractJs(rel, f.lang, f.tree.rootNode, this.options.keepSyntax));
      } catch (e) {
        // A single odd file must never stop the run.
        this.stats.parseErrors++;
        this.warnings.push(`frontend: could not analyze ${rel} (${(e as Error).message})`);
      }
    }
    this.resolver = new ModuleResolver(new Set(this.parsed.keys()), readTsPaths(this.root, this.warnings), this.root);
  }

  // --- binding resolution ---------------------------------------------------

  private moduleFile(fromRel: string, spec: string): string | null {
    const r = this.resolver.resolve(fromRel, spec);
    return r.kind === 'file' ? r.rel : null;
  }

  /** The project file an import specifier points at, or null (package, missing, excluded). */
  resolveModule(fromRel: string, spec: string): string | null {
    return this.resolver ? this.moduleFile(fromRel, spec) : null;
  }

  /** Resolve a name visible at module level of `rel` (top-level binding or import). */
  resolveName(rel: string, name: string, depth = 0): Target | null {
    if (depth > MAX_DEPTH) return null;
    const info = this.infos.get(rel);
    if (!info) return null;
    const top = info.top.get(name);
    if (top) {
      switch (top.kind) {
        case 'def':
          return { kind: 'def', file: rel, key: top.key };
        case 'object':
          return { kind: 'object', file: rel, binding: top };
        case 'instance':
          return { kind: 'instance', file: rel, base: top.base };
        case 'url':
          return { kind: 'url', file: rel, parts: top.parts };
        case 'alias':
          return top.name === name ? null : this.resolveName(rel, top.name, depth + 1);
        case 'value':
          return { kind: 'value', file: rel, name };
      }
    }
    for (const imp of info.imports) {
      const b = imp.bindings.find((x) => x.local === name);
      if (!b) continue;
      const file = this.moduleFile(rel, imp.source);
      if (!file) return null;
      return this.resolveExport(file, b.imported, depth + 1);
    }
    return null;
  }

  /** Resolve an exported name of a module, following re-exports and `export *`. */
  resolveExport(rel: string, name: string, depth = 0, seen = new Set<string>()): Target | null {
    if (depth > MAX_DEPTH) return null;
    if (name === '*') return { kind: 'namespace', file: rel };
    const key = `${rel}\u0000${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const info = this.infos.get(rel);
    if (!info) return null;
    const ex = info.exports.get(name);
    if (ex?.kind === 'local') {
      // Exported, but possibly an alias of an external import (const Form = FormProvider): null, not "missing".
      return this.resolveName(rel, ex.local, depth + 1) ?? (info.imports.some((i) => i.bindings.some((b) => b.local === ex.local)) || info.top.has(ex.local) ? null : { kind: 'value', file: rel, name });
    }
    if (ex?.kind === 'reexport') {
      const file = this.moduleFile(rel, ex.source);
      return file ? this.resolveExport(file, ex.imported, depth + 1, seen) : null;
    }
    if (name !== 'default') {
      for (const src of info.starExports) {
        const file = this.moduleFile(rel, src);
        const t = file ? this.resolveExport(file, name, depth + 1, seen) : null;
        if (t && t.kind !== 'missing') return t;
      }
    }
    return { kind: 'missing', file: rel, name };
  }

  /** Substitute module-level and imported constants into URL parts. */
  private resolveUrl(rel: string, alts: UrlPart[][], depth = 0): UrlPart[][] {
    if (depth > 6) return alts;
    const out: UrlPart[][] = [];
    for (const alt of alts) {
      let acc: UrlPart[][] = [[]];
      for (const p of alt) {
        let sub: UrlPart[][] | null = null;
        if (p.t === 'ident') {
          const t = this.resolveName(rel, p.name);
          if (t?.kind === 'url') sub = this.resolveUrl(t.file, t.parts, depth + 1);
          else if (this.config.next.baseUrlVariables.includes(p.name)) sub = [[{ t: 'base', name: p.name }]];
        } else if (p.t === 'member') {
          const t = this.resolveName(rel, p.object);
          const urls = t?.kind === 'object' ? t.binding.urls.get(p.prop) : undefined;
          if (t?.kind === 'object' && urls) sub = this.resolveUrl(t.file, urls, depth + 1);
          else if (this.config.next.baseUrlVariables.includes(`${p.object}.${p.prop}`)) sub = [[{ t: 'base', name: `${p.object}.${p.prop}` }]];
        }
        const next: UrlPart[][] = [];
        for (const a of acc) for (const s of sub ?? [[p]]) if (next.length < 4) next.push([...a, ...s]);
        acc = next;
      }
      out.push(...acc);
    }
    return out.slice(0, 4);
  }

  // --- graph ------------------------------------------------------------------

  resolve(graph: GraphBuilder): void {
    const defIds = new Map<string, Set<string>>(); // rel -> def keys
    for (const [rel, info] of this.infos) {
      const nx = nextFileInfo(rel);
      graph.addNode({
        id: feFileId(rel),
        kind: 'file',
        side: 'frontend',
        name: path.posix.basename(rel),
        file: rel,
        ...(nx.nextKind ? { nextKind: nx.nextKind } : {}),
        ...(nx.route ? { route: nx.route } : {}),
        ...(info.useClient ? { client: true } : {}),
        ...(this.parsed.get(rel)?.hasError ? { parseError: true } : {}),
      });
      const keys = new Set<string>();
      const classKeys = new Set(info.defs.filter((d) => d.kind === 'class').map((d) => d.key));
      for (const d of info.defs) {
        keys.add(d.key);
        const component = d.jsx && (d.kind === 'function' || d.kind === 'class') && (/^[A-Z]/.test(d.name) || d.name === 'default');
        const node: GraphNode = {
          id: feDefId(rel, d.key),
          kind: d.kind,
          side: 'frontend',
          name: d.name,
          file: rel,
          line: d.line,
          // Class methods nest in their class; object-literal members (api.get) nest in the file.
          parent: d.parentKey && classKeys.has(d.parentKey) ? feDefId(rel, d.parentKey) : feFileId(rel),
          ...(component ? { component: true } : {}),
        };
        graph.addNode(graph.ranges ? withEndLine(node, info.nodes.get(d)!.endPosition.row + 1) : node);
        this.stats.definitions++;
      }
      defIds.set(rel, keys);
    }
    const sourceId = (rel: string, from: string) => (from && defIds.get(rel)?.has(from) ? feDefId(rel, from) : feFileId(rel));

    for (const [rel, info] of this.infos) {
      const fid = feFileId(rel);
      // Import edges (file level).
      for (const imp of info.imports) {
        const r = this.resolver.resolve(rel, imp.source);
        if (r.kind === 'file') graph.addEdge({ source: fid, target: feFileId(r.rel), kind: 'imports', certain: true, line: imp.line });
        else if (r.kind === 'unresolved') {
          this.stats.unresolvedImports++;
          graph.diagnose('frontend', rel, 'unresolved import', imp.line, imp.source);
        }
      }
      // Calls and JSX renders.
      for (const call of info.calls) {
        const source = sourceId(rel, call.from);
        const kind = call.jsx ? 'renders' : 'calls';
        if (call.callee.t === 'id') {
          let t = this.resolveName(rel, call.callee.name);
          // Compound component: <Alert> renders the callable passed to Object.assign.
          if (t?.kind === 'object' && t.binding.callable) t = this.resolveName(t.file, t.binding.callable);
          if (t?.kind === 'def') graph.addEdge({ source, target: feDefId(t.file, t.key), kind, certain: true, line: call.line });
          else if (t?.kind === 'value') countReason(this.stats, 'not-a-definition');
          else if (t?.kind === 'missing') {
            countReason(this.stats, 'export-not-found');
            graph.diagnose('frontend', rel, `export "${t.name}" not found in ${t.file}`, call.line, call.callee.name);
          }
          continue;
        }
        const { object, prop } = call.callee;
        const t = this.resolveName(rel, object);
        if (!t || t.kind === 'instance' || t.kind === 'url') continue;
        if (t.kind === 'namespace') {
          const inner = this.resolveExport(t.file, prop);
          if (inner?.kind === 'def') graph.addEdge({ source, target: feDefId(inner.file, inner.key), kind, certain: true, line: call.line });
          else if (inner?.kind === 'missing') {
            countReason(this.stats, 'export-not-found');
            graph.diagnose('frontend', rel, `export "${prop}" not found in ${t.file}`, call.line, `${object}.${prop}`);
          }
        } else if (t.kind === 'object') {
          const key = t.binding.members.get(prop);
          const alias = t.binding.aliases.get(prop);
          // Inline member function, or a member that names a module-level function ({ list } / { Title: AlertTitle }).
          const target = key ? ({ kind: 'def', file: t.file, key } as const) : alias ? this.resolveName(t.file, alias) : null;
          if (target?.kind === 'def') graph.addEdge({ source, target: feDefId(target.file, target.key), kind, certain: true, line: call.line });
          else if (!key && !alias) countReason(this.stats, 'object-member-not-found');
          else if (target) countReason(this.stats, 'not-a-definition'); // alias to a value; null = external import
        } else if (t.kind === 'def' || t.kind === 'missing' || t.kind === 'value') {
          // Method call on an imported class/function value: not resolved (no type inference).
          countReason(this.stats, 'member-call');
          graph.diagnose('frontend', rel, 'member call on a project binding', call.line, `${object}.${prop}()`);
        }
      }
      // HTTP calls.
      for (const h of info.http) {
        let base: UrlPart[][] | null = null;
        if (h.client.t === 'binding') {
          const t = this.resolveName(rel, h.client.name);
          if (t?.kind !== 'instance') continue; // not an axios instance after all
          base = t.base ? this.resolveUrl(t.file, t.base) : null;
        }
        const source = sourceId(rel, h.from);
        if (!h.url) {
          this.httpCalls.push({ source, file: rel, line: h.line, method: h.method, url: [{ t: 'expr', text: '' }], viaBackendInstance: false, raw: h.raw });
          continue;
        }
        for (const alt of this.resolveUrl(rel, h.url)) {
          const absolute = alt[0]?.t === 'lit' && /^([a-z][a-z0-9+.-]*:)?\/\//i.test(alt[0].v);
          const parts: UrlPart[] = base && !absolute ? [...base[0], { t: 'lit', v: '/' }, ...alt] : alt;
          this.httpCalls.push({ source, file: rel, line: h.line, method: h.method, url: parts, viaBackendInstance: Boolean(base), raw: h.raw });
        }
      }
    }

    // Next.js route handlers become endpoints.
    for (const [rel, info] of this.infos) {
      const nx = nextFileInfo(rel);
      if (!nx.route) continue;
      if (nx.nextKind === 'route') {
        for (const m of ROUTE_HANDLER_METHODS) {
          if (!info.exports.has(m)) continue;
          const t = this.resolveExport(rel, m);
          const handler = t?.kind === 'def' ? feDefId(t.file, t.key) : feFileId(rel);
          this.addEndpoint(graph, [m], nx.route, rel, info.defs.find((d) => t?.kind === 'def' && d.key === t.key)?.line ?? 1, handler);
        }
      } else if (nx.nextKind === 'api') {
        const t = this.resolveExport(rel, 'default');
        const handler = t?.kind === 'def' ? feDefId(t.file, t.key) : feFileId(rel);
        this.addEndpoint(graph, ['ANY'], nx.route, rel, info.defs.find((d) => t?.kind === 'def' && d.key === t.key)?.line ?? 1, handler);
      }
    }
  }

  private addEndpoint(graph: GraphBuilder, methods: string[], route: string, rel: string, line: number, handler: string): void {
    const key = patternKey(nextPattern(route));
    const id = `endpoint:next:${methods.join('|')} ${key}`;
    if (graph.hasNode(id)) {
      this.warnings.push(`frontend: duplicate Next.js route handler ${methods.join('|')} ${route} (${rel})`);
      return;
    }
    const ep: Endpoint = { id, server: 'next', methods, path: route, file: rel, line, handler, handlerCertain: true };
    this.endpoints.push(ep);
    graph.addNode({ id, kind: 'endpoint', server: 'next', name: `${methods.join('|')} ${route}`, method: methods.join('|'), path: route, pattern: key, file: rel, line });
    graph.addEdge({ source: id, target: handler, kind: 'handles', certain: true });
  }

  listDefinitions(): string[] {
    const out: string[] = [];
    for (const [rel, info] of this.infos) {
      const nx = nextFileInfo(rel);
      const tags = [nx.nextKind, nx.route, info.useClient ? 'client' : undefined].filter(Boolean).join(' ');
      out.push(`${rel}${tags ? `  [${tags}]` : ''}`);
      for (const d of info.defs) out.push(`${rel}:${d.line}    ${d.kind} ${d.key}${d.jsx ? ' (jsx)' : ''}`);
      // Resolved HTTP calls only (candidates through non-axios bindings are dropped during resolve).
      for (const h of this.httpCalls) if (h.file === rel) out.push(`${rel}:${h.line}    http ${h.method ?? '?'} ${h.raw}`);
    }
    return out;
  }
}
