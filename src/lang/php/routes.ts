import type { SyntaxNode } from '../../parse.js';
import { dirnamePosix, joinPosix, normalizeRel } from '../../util/paths.js';
import { PhpScope, collectFileScope, phpString, stripLeadingSlash } from './names.js';

export type RouteAction =
  /** `classes`: candidate FQNs in priority order (string actions inside namespaced groups are ambiguous). */
  | { type: 'controller'; classes: string[]; method: string }
  | { type: 'closure'; line: number; startIndex: number; endIndex: number }
  | { type: 'unknown'; text: string };

/** A middleware reference as written on a route, a group or a route-file loader. */
export interface MiddlewareUse {
  /** Alias with parameters ('auth:sanctum', 'can:update,post'), a class FQN (parameters kept), or null when not a literal. */
  name: string | null;
  /** Source text, for reports. */
  text: string;
  file: string;
  line: number;
  via: 'route' | 'group' | 'resource' | 'loader';
}

/**
 * How the route file was loaded: 'seen' (bootstrap/app.php withRouting or a provider
 * chain we parsed), 'convention' (routes/web.php or routes/api.php with no loader
 * found: Laravel's default web/api group assumed), or 'unknown' (a loader we did not
 * see may add middleware).
 */
export type RouteLoader = 'seen' | 'convention' | 'unknown';

export interface RawRoute {
  methods: string[];
  /** Full URI with prefixes, always starting with '/'. */
  uri: string;
  action: RouteAction;
  file: string;
  line: number;
  /** Resource action name (index, show, ...) when expanded from a resource. */
  resourceAction?: string;
  /** Controller FQN that resolution picked among the candidates. */
  resolved?: string;
  /** Middleware in registration order: loader, outer groups first, then the route's own. */
  middleware: MiddlewareUse[];
  /** withoutMiddleware(...) on the route or an enclosing group. */
  excludedMiddleware: MiddlewareUse[];
  loader: RouteLoader;
  /** Set by the adapter during resolution. */
  endpointId?: string;
  handlerId?: string | null;
}

export interface RouteIssue {
  file: string;
  line: number;
  reason: string;
  text: string;
}

interface RouteCtx {
  prefix: string;
  /** Candidate FQNs of a Route::controller() group. */
  controller: string[] | null;
  /**
   * Candidate namespaces for 'Controller@method' strings, most likely first. A group
   * 'namespace' is relative to the route service provider's base namespace, which is
   * not visible statically (App\Http\Controllers before Laravel 8, often empty after),
   * so both readings are kept and resolution picks the first class that exists.
   */
  namespaces: string[];
  middleware: MiddlewareUse[];
  excluded: MiddlewareUse[];
  loader: RouteLoader;
}

/** What the extractor needs to know about the project. */
export interface RouteSource {
  /** Parsed route-capable files by relative path (routes/*.php, providers, bootstrap/app.php). */
  trees: Map<string, SyntaxNode>;
}

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match']);
const IGNORED = new Set(['view', 'redirect', 'permanentredirect', 'fallback', 'bind', 'model', 'pattern', 'patterns']);
const UNSUPPORTED = new Set(['singleton', 'apisingleton', 'singletons', 'apisingletons', 'resourceverbs']);
const RESOURCE_ACTIONS: { action: string; methods: string[]; suffix: (p: string) => string }[] = [
  { action: 'index', methods: ['GET'], suffix: () => '' },
  { action: 'create', methods: ['GET'], suffix: () => '/create' },
  { action: 'store', methods: ['POST'], suffix: () => '' },
  { action: 'show', methods: ['GET'], suffix: (p) => `/{${p}}` },
  { action: 'edit', methods: ['GET'], suffix: (p) => `/{${p}}/edit` },
  { action: 'update', methods: ['PATCH', 'PUT'], suffix: (p) => `/{${p}}` },
  { action: 'destroy', methods: ['DELETE'], suffix: (p) => `/{${p}}` },
];
const API_RESOURCE_ACTIONS = new Set(['index', 'store', 'show', 'update', 'destroy']);

const line = (n: SyntaxNode) => n.startPosition.row + 1;

/** Very small English singularizer, enough for resource parameter names (which become wildcards anyway). */
export function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y';
  if (/(ss|us)$/i.test(word)) return word;
  if (/(x|ch|sh|ss)es$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

export function joinUri(...parts: string[]): string {
  const segs = parts.flatMap((p) => p.split('/')).filter((s) => s !== '');
  return '/' + segs.join('/');
}

interface ChainCall {
  name: string;
  nameLower: string;
  args: SyntaxNode[];
  node: SyntaxNode;
}

export function argsOf(call: SyntaxNode): SyntaxNode[] {
  const args = call.childForFieldName('arguments');
  if (!args) return [];
  // Each `argument` wraps the expression; named arguments keep a `name` field.
  return args.namedChildren.filter((a) => a.type === 'argument').map((a) => a.namedChildren[a.namedChildren.length - 1]);
}

/**
 * Flatten `Route::prefix('x')->middleware('y')->group(...)` into its calls, or
 * null when the expression is not rooted at the Route facade (or a `$router` variable).
 */
function flattenRouteChain(expr: SyntaxNode, scope: PhpScope): ChainCall[] | null {
  const calls: ChainCall[] = [];
  let n: SyntaxNode | null = expr;
  while (n && (n.type === 'member_call_expression' || n.type === 'nullsafe_member_call_expression')) {
    const name = n.childForFieldName('name');
    if (!name) return null;
    calls.unshift({ name: name.text, nameLower: name.text.toLowerCase(), args: argsOf(n), node: n });
    n = n.childForFieldName('object');
  }
  if (!n) return null;
  if (n.type === 'scoped_call_expression') {
    const scopeNode = n.childForFieldName('scope');
    const name = n.childForFieldName('name');
    if (!scopeNode || !name) return null;
    const written = scopeNode.text;
    const resolved = scope.resolveClass(written);
    const isRoute =
      resolved === 'Illuminate\\Support\\Facades\\Route' || stripLeadingSlash(written) === 'Route' || resolved === 'Route';
    if (!isRoute) return null;
    calls.unshift({ name: name.text, nameLower: name.text.toLowerCase(), args: argsOf(n), node: n });
    return calls;
  }
  if (n.type === 'variable_name' && (n.text === '$router' || n.text === '$route') && calls.length) return calls;
  return null;
}

export function stringList(node: SyntaxNode | undefined): string[] | null {
  if (!node) return null;
  const single = phpString(node);
  if (single !== null) return [single];
  if (node.type !== 'array_creation_expression') return null;
  const out: string[] = [];
  for (const el of node.namedChildren) {
    if (el.type !== 'array_element_initializer') continue;
    const v = phpString(el.namedChildren[el.namedChildren.length - 1]);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/** Middleware names in one argument: 'auth', ['auth', 'verified'], Foo::class, Foo::class.':param'. Non-literals give null. */
export function middlewareNames(node: SyntaxNode | undefined, scope: PhpScope): { name: string | null; text: string }[] {
  if (!node) return [];
  const s = phpString(node);
  if (s !== null) return [{ name: s, text: s }];
  const cls = classConstant(node, scope);
  if (cls) return [{ name: cls, text: node.text }];
  if (node.type === 'binary_expression') {
    const left = classConstant(node.childForFieldName('left') ?? undefined, scope);
    const right = phpString(node.childForFieldName('right'));
    if (left && right !== null) return [{ name: left + right, text: node.text }];
  }
  if (node.type === 'array_creation_expression') {
    return node.namedChildren
      .filter((el) => el.type === 'array_element_initializer')
      .flatMap((el) => middlewareNames(el.namedChildren[el.namedChildren.length - 1], scope));
  }
  return [{ name: null, text: node.text.split('\n')[0].slice(0, 80) }];
}

/** Read `['prefix' => 'x', 'namespace' => 'Y']` style attribute arrays. */
export function arrayAttributes(node: SyntaxNode | undefined): Map<string, SyntaxNode> {
  const out = new Map<string, SyntaxNode>();
  if (!node || node.type !== 'array_creation_expression') return out;
  for (const el of node.namedChildren) {
    if (el.type !== 'array_element_initializer' || el.namedChildren.length !== 2) continue;
    const key = phpString(el.namedChildren[0]);
    if (key !== null) out.set(key, el.namedChildren[1]);
  }
  return out;
}

export class LaravelRouteExtractor {
  readonly routes: RawRoute[] = [];
  readonly issues: RouteIssue[] = [];
  /** Route files reached through require/include or group(file). */
  readonly included = new Set<string>();
  private scopes = new Map<string, PhpScope>();

  constructor(
    private source: RouteSource,
    private defaultControllerNamespace: string,
  ) {}

  /** Files referenced via require/include or ->group('file') anywhere in the given file. */
  static referencedFiles(rel: string, root: SyntaxNode): string[] {
    const out: string[] = [];
    for (const n of root.descendantsOfType(['require_expression', 'require_once_expression', 'include_expression', 'include_once_expression'])) {
      const target = resolveFileExpr(rel, n.namedChildren[0]);
      if (target) out.push(target);
    }
    for (const n of root.descendantsOfType('member_call_expression')) {
      if (n.childForFieldName('name')?.text !== 'group') continue;
      for (const a of argsOf(n)) {
        const target = resolveFileExpr(rel, a);
        if (target) out.push(target);
      }
    }
    return out;
  }

  /** Walk one route file with the given starting prefix (and the middleware its loader applies). */
  processFile(rel: string, prefix: string, stack: string[] = [], loader: { middleware: MiddlewareUse[]; state: RouteLoader } = { middleware: [], state: 'seen' }): void {
    const root = this.source.trees.get(rel);
    if (!root) return;
    if (stack.includes(rel)) {
      this.issues.push({ file: rel, line: 1, reason: 'circular route include', text: stack.concat(rel).join(' -> ') });
      return;
    }
    const ctx: RouteCtx = {
      prefix,
      controller: null,
      namespaces: [this.defaultControllerNamespace],
      middleware: loader.middleware,
      excluded: [],
      loader: loader.state,
    };
    this.walk(rel, root, ctx, stack.concat(rel));
  }

  private mw(args: SyntaxNode[], scope: PhpScope, rel: string, at: SyntaxNode, via: MiddlewareUse['via']): MiddlewareUse[] {
    return args.flatMap((a) => middlewareNames(a, scope)).map((m) => ({ ...m, file: rel, line: line(at), via }));
  }

  private scopeFor(rel: string): PhpScope {
    let s = this.scopes.get(rel);
    if (!s) {
      const root = this.source.trees.get(rel);
      s = root ? collectFileScope(root) : new PhpScope();
      this.scopes.set(rel, s);
    }
    return s;
  }

  private include(fromRel: string, target: string, ctx: RouteCtx, stack: string[], at: SyntaxNode): void {
    this.included.add(target);
    const root = this.source.trees.get(target);
    if (!root) {
      this.issues.push({ file: fromRel, line: line(at), reason: 'included route file not found or not scanned', text: target });
      return;
    }
    if (stack.includes(target)) return;
    this.walk(target, root, { ...ctx }, stack.concat(target));
  }

  private walk(rel: string, node: SyntaxNode, ctx: RouteCtx, stack: string[]): void {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case 'expression_statement': {
          const expr = child.namedChildren[0];
          if (!expr) break;
          if (expr.type.startsWith('require') || expr.type.startsWith('include')) {
            const target = resolveFileExpr(rel, expr.namedChildren[0]);
            if (target) this.include(rel, target, ctx, stack, expr);
            break;
          }
          const chain = flattenRouteChain(expr, this.scopeFor(rel));
          if (chain) this.handleChain(rel, chain, ctx, stack);
          else this.walk(rel, child, ctx, stack);
          break;
        }
        case 'function_definition':
          // Helper functions declared in route files are not route registrations.
          break;
        default:
          this.walk(rel, child, ctx, stack);
      }
    }
  }

  private applyAttribute(ctx: RouteCtx, call: ChainCall, scope: PhpScope, rel = '', via: MiddlewareUse['via'] = 'group'): RouteCtx {
    switch (call.nameLower) {
      case 'middleware':
        return { ...ctx, middleware: [...ctx.middleware, ...this.mw(call.args, scope, rel, call.node, via)] };
      case 'withoutmiddleware':
        return { ...ctx, excluded: [...ctx.excluded, ...this.mw(call.args, scope, rel, call.node, via)] };
      case 'prefix': {
        const p = phpString(call.args[0]);
        return p === null ? ctx : { ...ctx, prefix: joinUri(ctx.prefix, p) };
      }
      case 'controller': {
        const constant = classConstant(call.args[0], scope);
        const str = constant ? null : phpString(call.args[0]);
        if (constant) return { ...ctx, controller: qualifyController(constant, ctx) };
        return str ? { ...ctx, controller: qualifyString(str, ctx) } : ctx;
      }
      case 'namespace': {
        const ns = phpString(call.args[0]);
        return ns === null ? ctx : { ...ctx, namespaces: nestNamespace(ctx.namespaces, ns) };
      }
      default:
        return ctx; // name, as, domain, where, scopeBindings...
    }
  }

  /** `->can('update', 'post')` on a route: the `can:update,post` middleware. */
  private canMiddleware(call: ChainCall, rel: string): MiddlewareUse {
    const parts = call.args.map((a) => stringList(a));
    const name = parts.every((p) => p !== null) ? 'can:' + (parts as string[][]).flat().join(',') : null;
    const args = call.args.map((a) => a.text).join(', ');
    return { name, text: name ?? `can(${args.length > 60 ? args.slice(0, 59) + '…' : args})`, file: rel, line: line(call.node), via: 'route' };
  }

  private handleChain(rel: string, chain: ChainCall[], ctx: RouteCtx, stack: string[]): void {
    const scope = this.scopeFor(rel);
    const idx = chain.findIndex(
      (c) =>
        VERBS.has(c.nameLower) ||
        c.nameLower === 'group' ||
        c.nameLower.endsWith('resource') ||
        c.nameLower.endsWith('resources') ||
        IGNORED.has(c.nameLower) ||
        UNSUPPORTED.has(c.nameLower),
    );
    if (idx < 0) return;
    if (UNSUPPORTED.has(chain[idx].nameLower)) return this.issue(rel, chain[idx].node, `unsupported Route::${chain[idx].name}`);
    const head = chain[idx];
    const rest = chain.slice(idx + 1);
    // Attributes before the head: Route::middleware('auth')->get(...) is route-level, ->group(...) is group-level.
    let local = ctx;
    const via = head.nameLower === 'group' ? 'group' : VERBS.has(head.nameLower) ? 'route' : 'resource';
    for (let i = 0; i < idx; i++) local = this.applyAttribute(local, chain[i], scope, rel, via);

    if (head.nameLower === 'group') {
      let gctx = local;
      const attrs = arrayAttributes(head.args.length > 1 ? head.args[0] : undefined);
      const prefix = phpString(attrs.get('prefix'));
      if (prefix !== null) gctx = { ...gctx, prefix: joinUri(gctx.prefix, prefix) };
      const ns = phpString(attrs.get('namespace'));
      if (ns !== null) gctx = { ...gctx, namespaces: nestNamespace(gctx.namespaces, ns) };
      const ctrl = attrs.get('controller');
      if (ctrl) gctx = this.applyAttribute(gctx, { name: 'controller', nameLower: 'controller', args: [ctrl], node: ctrl }, scope);
      const groupMw = attrs.get('middleware');
      if (groupMw) gctx = { ...gctx, middleware: [...gctx.middleware, ...this.mw([groupMw], scope, rel, head.node, 'group')] };
      for (const key of ['excluded_middleware', 'withoutMiddleware']) {
        const ex = attrs.get(key);
        if (ex) gctx = { ...gctx, excluded: [...gctx.excluded, ...this.mw([ex], scope, rel, head.node, 'group')] };
      }
      const body = head.args[head.args.length - 1];
      if (!body) return;
      if (body.type === 'anonymous_function' || body.type === 'arrow_function') {
        const b = body.childForFieldName('body');
        if (b) {
          if (b.type === 'compound_statement') this.walk(rel, b, gctx, stack);
          else {
            const inner = flattenRouteChain(b, scope);
            if (inner) this.handleChain(rel, inner, gctx, stack);
          }
        }
      } else {
        const target = resolveFileExpr(rel, body);
        if (target) this.include(rel, target, gctx, stack, body);
        else this.issue(rel, head.node, 'unsupported group callback');
      }
      return;
    }

    if (IGNORED.has(head.nameLower)) return;

    if (VERBS.has(head.nameLower)) {
      let methods: string[];
      let uriNode: SyntaxNode | undefined;
      let actionNode: SyntaxNode | undefined;
      if (head.nameLower === 'match') {
        const list = stringList(head.args[0]);
        if (!list) return this.issue(rel, head.node, 'Route::match with non-literal methods');
        methods = list.map((m) => m.toUpperCase());
        uriNode = head.args[1];
        actionNode = head.args[2];
      } else {
        methods = head.nameLower === 'any' ? ['ANY'] : [head.nameLower.toUpperCase()];
        uriNode = head.args[0];
        actionNode = head.args[1];
      }
      const uri = phpString(uriNode);
      if (uri === null) return this.issue(rel, head.node, 'non-literal route URI');
      // Calls after the verb: ->middleware(), ->withoutMiddleware(), ->can().
      let middleware = local.middleware;
      let excluded = local.excluded;
      for (const c of rest) {
        if (c.nameLower === 'middleware') middleware = [...middleware, ...this.mw(c.args, scope, rel, c.node, 'route')];
        else if (c.nameLower === 'withoutmiddleware') excluded = [...excluded, ...this.mw(c.args, scope, rel, c.node, 'route')];
        else if (c.nameLower === 'can') middleware = [...middleware, this.canMiddleware(c, rel)];
      }
      this.routes.push({
        methods: [...new Set(methods)].sort(),
        uri: joinUri(local.prefix, uri),
        action: this.parseAction(actionNode, local, scope),
        file: rel,
        line: line(head.node),
        middleware,
        excludedMiddleware: excluded,
        loader: local.loader,
      });
      return;
    }

    // resource / apiResource / resources / apiResources (and singleton variants are unsupported).
    const isApi = head.nameLower.startsWith('api');
    if (head.nameLower === 'resources' || head.nameLower === 'apiresources') {
      const map = arrayAttributes(head.args[0]);
      for (const [name, ctrlNode] of map) this.expandResource(rel, head, name, ctrlNode, isApi, [], local, scope);
      return;
    }
    if (head.nameLower !== 'resource' && head.nameLower !== 'apiresource') {
      return this.issue(rel, head.node, `unsupported Route::${head.name}`);
    }
    const name = phpString(head.args[0]);
    if (name === null) return this.issue(rel, head.node, 'non-literal resource name');
    this.expandResource(rel, head, name, head.args[1], isApi, rest, local, scope);
  }

  private expandResource(
    rel: string,
    head: ChainCall,
    name: string,
    ctrlNode: SyntaxNode | undefined,
    isApi: boolean,
    rest: ChainCall[],
    ctx: RouteCtx,
    scope: PhpScope,
  ): void {
    const constant = classConstant(ctrlNode, scope);
    const str = constant ? null : phpString(ctrlNode);
    if (!constant && !str) return this.issue(rel, head.node, 'resource controller is not a class constant');
    const classes = constant ? qualifyController(constant, ctx) : qualifyString(str as string, ctx);
    let actions = RESOURCE_ACTIONS.filter((a) => !isApi || API_RESOURCE_ACTIONS.has(a.action));
    // Third argument options array: ['only' => [...]] / ['except' => [...]].
    const opts = arrayAttributes(head.args[2]);
    const filters: { kind: string; list: string[] | null }[] = [];
    if (opts.has('only')) filters.push({ kind: 'only', list: stringList(opts.get('only')) });
    if (opts.has('except')) filters.push({ kind: 'except', list: stringList(opts.get('except')) });
    for (const c of rest) {
      if (c.nameLower === 'only' || c.nameLower === 'except') {
        const list = c.args.length === 1 ? stringList(c.args[0]) : c.args.map((a) => phpString(a)).every((x) => x !== null) ? (c.args.map((a) => phpString(a)) as string[]) : null;
        filters.push({ kind: c.nameLower, list });
      }
    }
    for (const f of filters) {
      if (!f.list) {
        this.issue(rel, head.node, `non-literal ->${f.kind}() on resource`);
        continue;
      }
      const set = new Set(f.list);
      actions = actions.filter((a) => (f.kind === 'only' ? set.has(a.action) : !set.has(a.action)));
    }
    // 'posts.comments' => posts/{post}/comments ; 'admin/photos' => admin/photos.
    const parts = name.split('.');
    const last = parts.pop() as string;
    const base = joinUri(ctx.prefix, ...parts.map((p) => `${p}/{${singular(p.split('/').pop() as string)}}`), last);
    const param = singular(last.split('/').pop() as string);
    // ->middleware()/->withoutMiddleware() apply to every action; ->middlewareFor()/->withoutMiddlewareFor() to some.
    const forActions = (c: ChainCall): Set<string> | null => {
      const list = stringList(c.args[0]);
      return list ? new Set(list) : null;
    };
    for (const a of actions) {
      let middleware = ctx.middleware;
      let excluded = ctx.excluded;
      for (const c of rest) {
        if (c.nameLower === 'middleware') middleware = [...middleware, ...this.mw(c.args, scope, rel, c.node, 'resource')];
        else if (c.nameLower === 'withoutmiddleware') excluded = [...excluded, ...this.mw(c.args, scope, rel, c.node, 'resource')];
        else if (c.nameLower === 'middlewarefor' || c.nameLower === 'withoutmiddlewarefor') {
          const set = forActions(c);
          const uses = this.mw(c.args.slice(1), scope, rel, c.node, 'resource');
          // Unknown action list: keep the middleware as an unresolvable reference rather than guessing.
          const applied = set === null ? uses.map((u) => ({ ...u, name: null })) : set.has(a.action) ? uses : [];
          if (c.nameLower === 'middlewarefor') middleware = [...middleware, ...applied];
          else excluded = [...excluded, ...applied];
        }
      }
      this.routes.push({
        methods: a.methods,
        uri: joinUri(base, a.suffix(param)),
        action: { type: 'controller', classes, method: a.action },
        file: rel,
        line: line(head.node),
        resourceAction: a.action,
        middleware,
        excludedMiddleware: excluded,
        loader: ctx.loader,
      });
    }
  }

  private parseAction(node: SyntaxNode | undefined, ctx: RouteCtx, scope: PhpScope): RouteAction {
    if (!node) return { type: 'unknown', text: '(missing action)' };
    if (node.type === 'anonymous_function' || node.type === 'arrow_function') {
      return { type: 'closure', line: line(node), startIndex: node.startIndex, endIndex: node.endIndex };
    }
    const cls = classConstant(node, scope);
    if (cls) return { type: 'controller', classes: qualifyController(cls, ctx), method: '__invoke' };
    if (node.type === 'array_creation_expression') {
      const els = node.namedChildren.filter((e) => e.type === 'array_element_initializer');
      // ['uses' => 'C@m'] legacy form
      const attrs = arrayAttributes(node);
      if (attrs.has('uses')) return this.parseAction(attrs.get('uses'), ctx, scope);
      if (els.length >= 1 && els[0].namedChildren.length === 1) {
        // [Controller::class, 'method'] or ['Fully\\Qualified\\Controller', 'method'] (callable strings are absolute).
        const c = classConstant(els[0].namedChildren[0], scope) ?? phpString(els[0].namedChildren[0]);
        const m = els.length >= 2 ? phpString(els[1].namedChildren[0]) : '__invoke';
        if (c && m) return { type: 'controller', classes: qualifyController(c, ctx), method: m };
      }
      return { type: 'unknown', text: node.text };
    }
    const str = phpString(node);
    if (str !== null) {
      if (str.includes('@')) {
        const [c, m] = str.split('@');
        return { type: 'controller', classes: qualifyString(c, ctx), method: m };
      }
      if (ctx.controller) return { type: 'controller', classes: ctx.controller, method: str };
      return { type: 'controller', classes: qualifyString(str, ctx), method: '__invoke' };
    }
    return { type: 'unknown', text: node.text.slice(0, 80) };
  }

  private issue(rel: string, node: SyntaxNode, reason: string): void {
    this.issues.push({ file: rel, line: line(node), reason, text: node.text.split('\n')[0].slice(0, 100) });
  }
}

const dedupe = (xs: string[]) => [...new Set(xs)];

/** Apply a group `namespace`: absolute with a leading backslash, else relative to each candidate (or absolute). */
function nestNamespace(current: string[], ns: string): string[] {
  if (ns.startsWith('\\')) return [ns.slice(1)];
  const clean = ns.replace(/\\$/, '');
  return dedupe([...current.map((p) => (p ? `${p}\\${clean}` : clean)), clean]);
}

/**
 * A controller class from `Foo::class` (already resolved through `use`). Names that
 * stayed unqualified (no `use`, global namespace) also try the route controller
 * namespaces, mirroring Laravel's legacy behaviour.
 */
function qualifyController(fqn: string, ctx: RouteCtx): string[] {
  const clean = stripLeadingSlash(fqn);
  return clean.includes('\\') ? [clean] : dedupe([...ctx.namespaces.map((p) => (p ? `${p}\\${clean}` : clean)), clean]);
}

/** A controller written as a string ('Admin\\ReportController@index'): relative to the group namespaces unless it starts with a backslash. */
function qualifyString(name: string, ctx: RouteCtx): string[] {
  if (name.startsWith('\\')) return [name.slice(1)];
  return dedupe([...ctx.namespaces.map((p) => (p ? `${p}\\${name}` : name)), name]);
}

/** `Foo::class` -> resolved FQN. */
export function classConstant(node: SyntaxNode | undefined, scope: PhpScope): string | null {
  if (!node || node.type !== 'class_constant_access_expression') return null;
  const [cls, constant] = node.namedChildren;
  if (!cls || constant?.text.toLowerCase() !== 'class') return null;
  if (cls.type !== 'name' && cls.type !== 'qualified_name') return null;
  return scope.resolveClass(cls.text);
}

/**
 * Resolve `__DIR__.'/auth.php'`, `base_path('routes/x.php')` or a literal path
 * to a project-relative path. `rel` is the file containing the expression.
 */
export function resolveFileExpr(rel: string, node: SyntaxNode | undefined): string | null {
  if (!node) return null;
  if (node.type === 'parenthesized_expression') return resolveFileExpr(rel, node.namedChildren[0]);
  if (node.type === 'function_call_expression') {
    const fn = node.childForFieldName('function')?.text;
    if (fn !== 'base_path') return null;
    const arg = argsOf(node)[0];
    const p = phpString(arg);
    return p === null ? null : normalizeRel(p);
  }
  if (node.type === 'binary_expression') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const tail = phpString(right);
    if (left?.text === '__DIR__' && tail !== null) return normalizeRel(joinPosix(dirnamePosix(rel), tail));
    if (left?.type === 'function_call_expression' && left.childForFieldName('function')?.text === 'base_path' && tail !== null) {
      const head = phpString(argsOf(left)[0]) ?? '';
      return normalizeRel(joinPosix(head, tail));
    }
    return null;
  }
  return null;
}

/**
 * Extract every route from the route-capable files. Files reached through
 * require/include or ->group('file') are walked from their includer and inherit
 * its prefix; the others are entry points. routes/api.php gets `apiPrefix`.
 * Providers and bootstrap/app.php are walked first because they may include
 * route files with their own prefixes (Laravel <= 10 RouteServiceProvider).
 */
export function extractRoutes(
  trees: Map<string, SyntaxNode>,
  opts: { controllerNamespace: string; apiPrefix: string },
): LaravelRouteExtractor {
  const extractor = new LaravelRouteExtractor({ trees }, opts.controllerNamespace);
  const referenced = new Set<string>();
  for (const [rel, root] of trees) for (const r of LaravelRouteExtractor.referencedFiles(rel, root)) referenced.add(r);
  const registrars = [...trees.keys()].filter((r) => !r.startsWith('routes/')).sort();
  for (const rel of registrars) extractor.processFile(rel, '');
  const loaders = routingLoaders(trees.get('bootstrap/app.php'));
  const entries = [...trees.keys()].filter((r) => r.startsWith('routes/') && !referenced.has(r)).sort();
  for (const rel of entries) {
    const seen = loaders.get(rel);
    const conventional = rel === 'routes/web.php' ? 'web' : rel === 'routes/api.php' ? 'api' : null;
    const loader = seen
      ? { middleware: [seen], state: 'seen' as const }
      : conventional
        ? { middleware: [{ name: conventional, text: conventional, file: rel, line: 1, via: 'loader' as const }], state: 'convention' as const }
        : { middleware: [], state: 'unknown' as const };
    extractor.processFile(rel, rel === 'routes/api.php' ? opts.apiPrefix : '', [], loader);
  }
  return extractor;
}

/** Laravel 11+ `->withRouting(web: __DIR__.'/../routes/web.php', api: ...)`: each file gets its middleware group. */
function routingLoaders(boot: SyntaxNode | undefined): Map<string, MiddlewareUse> {
  const out = new Map<string, MiddlewareUse>();
  if (!boot) return out;
  for (const call of boot.descendantsOfType('member_call_expression')) {
    if (call.childForFieldName('name')?.text !== 'withRouting') continue;
    for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) {
      const group = arg.childForFieldName('name')?.text;
      if (group !== 'web' && group !== 'api') continue;
      const target = resolveFileExpr('bootstrap/app.php', arg.namedChildren[arg.namedChildren.length - 1]);
      if (target) out.set(target, { name: group, text: group, file: 'bootstrap/app.php', line: arg.startPosition.row + 1, via: 'loader' });
    }
  }
  return out;
}
