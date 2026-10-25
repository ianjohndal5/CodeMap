import fs from 'node:fs';
import path from 'node:path';
import { type Adapter, countReason, emptyStats } from '../../adapter.js';
import type { CodemapConfig } from '../../config.js';
import { type ComposerInfo, readComposer } from '../../detect.js';
import { withEndLine, type GraphBuilder } from '../../graph.js';
import { laravelPattern, patternKey } from '../../match/url.js';
import { type ParsedFile, type SyntaxNode, parseFile, parseSource, readSource } from '../../parse.js';
import { scanLaravel } from '../../scan.js';
import type { Endpoint, GraphNode, HttpCall } from '../../types.js';
import { endLineOf, extractPhp, type PhpClass, type PhpFileInfo, type PhpFunction, type PhpOwner } from './extract.js';
import { phpString } from './names.js';
import { type LaravelRouteExtractor, type RawRoute, extractRoutes, joinUri } from './routes.js';

/** Fluent-chain calls (`User::query()->latest()`) are reported but not counted as unresolved. */
const NOT_COUNTED = new Set(['chained-call']);

const ROLES: [string, string][] = [
  ['Http/Controllers/', 'controller'],
  ['Http/Requests/', 'request'],
  ['Http/Middleware/', 'middleware'],
  ['Http/Resources/', 'resource'],
  ['Models/', 'model'],
  ['Services/', 'service'],
  ['Repositories/', 'repository'],
  ['Jobs/', 'job'],
  ['Events/', 'event'],
  ['Listeners/', 'listener'],
  ['Policies/', 'policy'],
  ['Providers/', 'provider'],
];

export function backendRole(rel: string): string {
  if (rel.startsWith('routes/')) return 'routes';
  const p = '/' + rel;
  for (const [frag, role] of ROLES) if (p.includes('/' + frag)) return role;
  return 'other';
}

export const fileId = (rel: string) => `be:${rel}`;

export class LaravelAdapter implements Adapter {
  readonly side = 'backend' as const;
  readonly endpoints: Endpoint[] = [];
  readonly httpCalls: HttpCall[] = [];
  readonly stats = emptyStats();
  files: string[] = [];
  composer!: ComposerInfo;
  parsed = new Map<string, ParsedFile>();
  infos: PhpFileInfo[] = [];
  routes: RawRoute[] = [];
  /** bootstrap/app.php, parsed separately (it is outside the scanned directories). */
  bootstrap: SyntaxNode | null = null;
  /** Class lookup by FQN (PSR-4 first) and each class's file; available after resolve(). */
  findClass: (fqn: string) => PhpClass | null = () => null;
  readonly classFiles = new Map<PhpClass, string>();
  private routeExtractor: LaravelRouteExtractor | null = null;

  /** `keepSyntax`: keep definition nodes and scopes after extraction (needed by the security lens). */
  constructor(
    readonly root: string,
    private config: CodemapConfig,
    private warnings: string[],
    private options: { keepSyntax?: boolean } = {},
  ) {}

  scan(): void {
    this.composer = readComposer(this.root, this.warnings);
    this.files = scanLaravel(this.root, this.composer, this.config);
  }

  parse(): void {
    for (const rel of this.files) {
      const r = parseFile(this.root, rel);
      if (r.ok) {
        this.parsed.set(rel, r.file);
        if (r.file.hasError) this.stats.parseErrors++;
      } else {
        this.stats.parseErrors++;
        this.warnings.push(`backend: skipped ${rel} (${r.reason})`);
      }
    }
    const boot = path.join(this.root, 'bootstrap', 'app.php');
    if (fs.existsSync(boot)) {
      try {
        this.bootstrap = parseSource('php', readSource(boot)).rootNode;
      } catch {
        this.warnings.push('backend: could not parse bootstrap/app.php');
      }
    }
    this.stats.files = this.parsed.size;
  }

  /** Controller namespace for 'Controller@method' strings: config, else the PSR-4 prefix of app/ + Http\Controllers. */
  private controllerNamespace(): string {
    if (this.config.laravel.controllerNamespace) return this.config.laravel.controllerNamespace.replace(/^\\|\\$/g, '');
    const app = this.composer.psr4.find((p) => p.dirs.includes('app'));
    return `${(app?.prefix ?? 'App\\').replace(/\\$/, '')}\\Http\\Controllers`;
  }

  /** apiPrefix from config, else `apiPrefix:` in bootstrap/app.php (Laravel 11+), else /api. */
  private apiPrefix(): string {
    if (this.config.laravel.apiPrefix !== undefined) return joinUri(this.config.laravel.apiPrefix);
    if (this.bootstrap) {
      for (const arg of this.bootstrap.descendantsOfType('argument')) {
        if (arg.childForFieldName('name')?.text === 'apiPrefix') {
          const v = phpString(arg.namedChildren[arg.namedChildren.length - 1]);
          if (v !== null) return joinUri(v);
        }
      }
    }
    return '/api';
  }

  extract(): void {
    // 1. Routes: route files, route service providers and bootstrap/app.php can register routes.
    const trees = new Map<string, SyntaxNode>();
    for (const [rel, f] of this.parsed) {
      if (rel.startsWith('routes/') || rel.endsWith('Providers/RouteServiceProvider.php')) trees.set(rel, f.tree.rootNode);
    }
    if (this.bootstrap) trees.set('bootstrap/app.php', this.bootstrap);
    const extractor = extractRoutes(trees, { controllerNamespace: this.controllerNamespace(), apiPrefix: this.apiPrefix() });
    this.routes = extractor.routes;
    this.routeExtractor = extractor;

    // 2. Definitions and references; closures used as route actions become handler nodes.
    const closures = new Map<string, Map<number, number>>();
    for (const r of this.routes) {
      if (r.action.type !== 'closure') continue;
      let m = closures.get(r.file);
      if (!m) closures.set(r.file, (m = new Map()));
      m.set(r.action.startIndex, r.action.endIndex);
    }
    for (const [rel, f] of this.parsed) {
      try {
        this.infos.push(extractPhp(rel, f.tree.rootNode, closures.get(rel), this.options.keepSyntax));
      } catch (e) {
        // A single odd file must never stop the run.
        this.stats.parseErrors++;
        this.warnings.push(`backend: could not analyze ${rel} (${(e as Error).message})`);
      }
    }
  }

  resolve(graph: GraphBuilder): void {
    const classes = new Map<string, { cls: PhpClass; file: string }>();
    const functions = new Map<string, { fn: PhpFunction; file: string }>();
    const closureIds = new Map<string, string>(); // `${file}:${startIndex}` -> id

    // Nodes for files, classes, methods, functions, closures.
    for (const info of this.infos) {
      const fid = fileId(info.rel);
      const role = backendRole(info.rel);
      graph.addNode({
        id: fid,
        kind: 'file',
        side: 'backend',
        name: path.posix.basename(info.rel),
        file: info.rel,
        role,
        ...(this.parsed.get(info.rel)?.hasError ? { parseError: true } : {}),
      });
      for (const cls of info.classes) {
        const key = cls.fqn.toLowerCase();
        cls.id = classes.has(key) ? `be:${cls.fqn}@${info.rel}` : `be:${cls.fqn}`;
        if (!classes.has(key)) classes.set(key, { cls, file: info.rel });
        else this.warnings.push(`backend: ${cls.fqn} is declared more than once (${classes.get(key)!.file}, ${info.rel})`);
        const clsNode: GraphNode = { id: cls.id, kind: cls.kind, side: 'backend', name: cls.name, file: info.rel, line: cls.line, parent: fid, role };
        graph.addNode(graph.ranges ? withEndLine(clsNode, endLineOf(info, cls)) : clsNode);
        this.stats.definitions++;
        const seen = new Set<string>();
        for (const m of cls.methods) {
          if (seen.has(m.name.toLowerCase())) continue;
          seen.add(m.name.toLowerCase());
          const methodNode: GraphNode = {
            id: `${cls.id}::${m.name}`,
            kind: 'method',
            side: 'backend',
            name: m.name,
            file: info.rel,
            line: m.line,
            parent: cls.id,
            role,
            visibility: m.visibility,
            ...(m.static ? { static: true } : {}),
          };
          graph.addNode(graph.ranges ? withEndLine(methodNode, endLineOf(info, m)) : methodNode);
          this.stats.definitions++;
        }
      }
      for (const fn of info.functions) {
        const key = fn.fqn.toLowerCase();
        fn.id = functions.has(key) ? `be:${fn.fqn}()@${info.rel}` : `be:${fn.fqn}()`;
        if (!functions.has(key)) functions.set(key, { fn, file: info.rel });
        const fnNode: GraphNode = { id: fn.id, kind: 'function', side: 'backend', name: fn.name + '()', file: info.rel, line: fn.line, parent: fid, role };
        graph.addNode(graph.ranges ? withEndLine(fnNode, endLineOf(info, fn)) : fnNode);
        this.stats.definitions++;
      }
      const lines = new Map<number, number>();
      for (const c of info.closures) lines.set(c.line, (lines.get(c.line) ?? 0) + 1);
      for (const c of info.closures) {
        const id = `be:${info.rel}#closure@${c.line}${(lines.get(c.line) ?? 0) > 1 ? ':' + c.col : ''}`;
        closureIds.set(`${info.rel}:${c.startIndex}`, id);
        const closureNode: GraphNode = { id, kind: 'closure', side: 'backend', name: `closure@${c.line}`, file: info.rel, line: c.line, parent: fid, role };
        graph.addNode(graph.ranges ? withEndLine(closureNode, endLineOf(info, c)) : closureNode);
        this.stats.definitions++;
      }
    }

    const classesByFile = new Map<string, PhpClass[]>();
    for (const info of this.infos) {
      classesByFile.set(info.rel, info.classes);
      for (const cls of info.classes) this.classFiles.set(cls, info.rel);
    }
    const findClass = (fqn: string): PhpClass | null => {
      // PSR-4 first (FQN -> expected file), then any scanned declaration (non-PSR-4 files, composer "files").
      const viaPsr4 = this.psr4File(fqn);
      const lower = fqn.toLowerCase();
      const inPsr4File = viaPsr4 ? classesByFile.get(viaPsr4)?.find((c) => c.fqn.toLowerCase() === lower) : undefined;
      return inPsr4File ?? classes.get(lower)?.cls ?? null;
    };
    this.findClass = findClass;
    const methodId = (cls: PhpClass, name: string): string | null => {
      const m = cls.methods.find((x) => x.name.toLowerCase() === name.toLowerCase());
      return m ? `${cls.id}::${m.name}` : null;
    };

    // Edges.
    for (const info of this.infos) {
      const fid = fileId(info.rel);
      const ownerId = (o: PhpOwner): string => {
        switch (o.type) {
          case 'file':
            return fid;
          case 'method':
            return methodId(o.cls, o.method) ?? (o.cls.id as string);
          case 'function':
            return o.fn.id as string;
          case 'closure':
            return closureIds.get(`${info.rel}:${o.closure.startIndex}`) ?? fid;
        }
      };
      for (const u of info.useStatements) {
        const cls = findClass(u.fqn);
        if (cls) graph.addEdge({ source: fid, target: cls.id as string, kind: 'uses', certain: true, line: u.line });
      }
      for (const ref of info.refs) {
        const source = ownerId(ref.owner);
        switch (ref.kind) {
          case 'extends':
          case 'implements':
          case 'trait': {
            const cls = findClass(ref.cls);
            if (cls) graph.addEdge({ source: ref.from.id as string, target: cls.id as string, kind: 'uses', certain: true, line: ref.line, via: ref.kind });
            break;
          }
          case 'this':
          case 'self': {
            const cls = findClass(ref.cls);
            if (!cls) break;
            const target = methodId(cls, ref.method);
            if (target) graph.addEdge({ source, target, kind: 'calls', certain: true, line: ref.line });
            else {
              // Probably inherited (inheritance is not followed): keep it, but uncertain.
              graph.addEdge({ source, target: cls.id as string, kind: 'calls', certain: false, line: ref.line, via: 'inherited?' });
            }
            break;
          }
          case 'static':
          case 'typed': {
            const cls = findClass(ref.cls);
            if (!cls) break; // external (framework/vendor) class
            const target = methodId(cls, ref.method);
            graph.addEdge({ source, target: target ?? (cls.id as string), kind: 'calls', certain: true, line: ref.line, via: ref.kind });
            break;
          }
          case 'new': {
            const cls = findClass(ref.cls);
            if (cls) graph.addEdge({ source, target: cls.id as string, kind: 'calls', certain: true, line: ref.line, via: 'new' });
            break;
          }
          case 'function': {
            const hit = ref.candidates.map((c) => functions.get(c.toLowerCase())).find(Boolean);
            if (hit) graph.addEdge({ source, target: hit.fn.id as string, kind: 'calls', certain: true, line: ref.line });
            break;
          }
        }
      }
      for (const u of info.unresolved) {
        countReason(this.stats, u.reason, !NOT_COUNTED.has(u.reason));
        if (!NOT_COUNTED.has(u.reason)) graph.diagnose('backend', info.rel, u.reason, u.line, u.text);
      }
    }

    // Endpoints. Laravel keeps the last registration of a method+URI, so later routes win.
    const byId = new Map<string, Endpoint>();
    for (const r of this.routes) {
      const segs = laravelPattern(r.uri);
      const methods = r.methods;
      const id = `endpoint:laravel:${methods.join('|')} ${patternKey(segs)}`;
      let handler: string | null = null;
      let handlerCertain = true;
      if (r.action.type === 'closure') {
        handler = closureIds.get(`${r.file}:${r.action.startIndex}`) ?? null;
      } else if (r.action.type === 'controller') {
        const cls = r.action.classes.map((c) => findClass(c)).find((c): c is PhpClass => c !== null);
        if (cls) {
          r.resolved = cls.fqn;
          handler = methodId(cls, r.action.method);
          if (!handler) {
            handler = cls.id as string;
            handlerCertain = false;
            graph.diagnose('backend', r.file, 'route action method not defined in controller', r.line, `${cls.fqn}::${r.action.method}`);
          }
        } else {
          graph.diagnose('backend', r.file, 'route controller not found', r.line, `${r.action.classes[0]}@${r.action.method}`);
        }
      } else {
        graph.diagnose('backend', r.file, 'unsupported route action', r.line, r.action.text);
      }
      if (!handler) this.stats.unresolvedHandlers++;
      r.endpointId = id;
      r.handlerId = handler;
      if (byId.has(id)) this.warnings.push(`backend: route ${methods.join('|')} ${r.uri} is defined more than once; the last definition wins (${r.file}:${r.line})`);
      byId.set(id, { id, server: 'laravel', methods, path: r.uri, file: r.file, line: r.line, handler, handlerCertain });
    }
    for (const issue of this.routeExtractor?.issues ?? []) {
      graph.diagnose('backend', issue.file, issue.reason, issue.line, issue.text);
      this.warnings.push(`backend: ${issue.file}:${issue.line} ${issue.reason}`);
    }
    for (const ep of [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      this.endpoints.push(ep);
      graph.addNode({
        id: ep.id,
        kind: 'endpoint',
        server: 'laravel',
        name: `${ep.methods.join('|')} ${ep.path}`,
        method: ep.methods.join('|'),
        path: ep.path,
        pattern: patternKey(laravelPattern(ep.path)),
        file: ep.file,
        line: ep.line,
      });
      if (ep.handler) graph.addEdge({ source: ep.id, target: ep.handler, kind: 'handles', certain: ep.handlerCertain });
    }
  }

  private psr4File(fqn: string): string | null {
    for (const { prefix, dirs } of this.composer.psr4) {
      if (!fqn.startsWith(prefix)) continue;
      const rest = fqn.slice(prefix.length).split('\\').join('/') + '.php';
      for (const d of dirs) {
        const rel = d ? `${d}/${rest}` : rest;
        if (this.parsed.has(rel)) return rel;
      }
    }
    return null;
  }

  listDefinitions(): string[] {
    const out: string[] = [];
    for (const info of this.infos) {
      for (const c of info.classes) {
        out.push(`${info.rel}:${c.line}  ${c.kind} ${c.fqn}`);
        for (const m of c.methods) out.push(`${info.rel}:${m.line}    method ${c.fqn}::${m.name} (${m.visibility}${m.static ? ', static' : ''})`);
      }
      for (const f of info.functions) out.push(`${info.rel}:${f.line}  function ${f.fqn}()`);
      for (const c of info.closures) out.push(`${info.rel}:${c.line}  closure (route handler)`);
    }
    for (const r of this.routes) {
      const action =
        r.action.type === 'controller'
          ? `${r.resolved ?? r.action.classes[0] + ' (not found)'}@${r.action.method}`
          : r.action.type === 'closure'
            ? `closure@${r.action.line}`
            : '?';
      out.push(`${r.file}:${r.line}  route ${r.methods.join('|')} ${r.uri} -> ${action}`);
    }
    return out;
  }
}
