import type { PhpClass } from '../lang/php/extract.js';
import { phpString } from '../lang/php/names.js';
import { argsOf, arrayAttributes, classConstant, middlewareNames, stringList } from '../lang/php/routes.js';
import type { SyntaxNode } from '../parse.js';
import { ATTR_AUTHORIZE, ATTR_MIDDLEWARE, ATTR_WITHOUT, CONTROLLER_MIDDLEWARE, FRAMEWORK_CONTROLLERS, HAS_MIDDLEWARE } from './catalog.js';
import { CONDITIONAL_TYPES, enclosing, firstLine, FUNCTION_TYPES, type PhpIndex } from './php.js';
import { namedArgs } from './registry.js';

/** A middleware declared by a controller, already filtered for one action. */
export interface ControllerMiddleware {
  name: string | null;
  text: string;
  file: string;
  line: number;
  /** 'maybe' when only/except or a surrounding condition could not be read. */
  applies: 'yes' | 'maybe';
  closure: boolean;
  /** Declaring class, when inherited from a parent controller. */
  inherited?: string;
}

export interface ControllerResult {
  middleware: ControllerMiddleware[];
  /** From #[WithoutMiddleware] attributes. */
  excluded: { name: string | null; text: string; file: string; line: number }[];
  unknown: { reason: string; text: string }[];
}

/** Method lists: literal, or '?' when not readable. */
type Methods = string[] | '?' | null;

interface Declaration {
  names: { name: string | null; text: string }[];
  closure: boolean;
  only: Methods;
  except: Methods;
  conditional: boolean;
  file: string;
  line: number;
  cls: PhpClass;
}

/** `authorizeResource` ability per resource method (AuthorizesRequests::resourceAbilityMap). */
const RESOURCE_ABILITIES: Record<string, string> = {
  index: 'viewAny',
  show: 'view',
  create: 'create',
  store: 'create',
  edit: 'update',
  update: 'update',
  destroy: 'delete',
};
const WITHOUT_MODELS = new Set(['index', 'create', 'store']);

function methodList(nodes: SyntaxNode[]): Methods {
  if (!nodes.length) return '?';
  if (nodes.length === 1) return stringList(nodes[0]) ?? '?';
  const all = nodes.map((n) => phpString(n));
  return all.every((x) => x !== null) ? (all as string[]) : '?';
}

/**
 * `$this->middleware(...)` / `$this->authorizeResource(...)` calls in a body, located from the
 * text and looked up in the tree: constructors full of closures make a full walk slow.
 */
function thisCalls(body: SyntaxNode): SyntaxNode[] {
  const out = new Map<number, SyntaxNode>();
  const re = /\$this\s*->\s*(middleware|authorizeResource)\s*\(/g;
  const text = body.text;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = body.startIndex + m.index + m[0].indexOf(m[1]);
    for (let n: SyntaxNode | null = body.descendantForIndex(at); n && n.id !== body.id; n = n.parent) {
      if (n.type === 'member_call_expression') {
        out.set(n.id, n);
        break;
      }
    }
  }
  return [...out.values()];
}

function appliesTo(method: string, only: Methods, except: Methods): 'yes' | 'no' | 'maybe' {
  if (only === '?' || except === '?') return 'maybe';
  if (only && !only.includes(method)) return 'no';
  if (except && except.includes(method)) return 'no';
  return 'yes';
}

/**
 * Controller-level middleware: `$this->middleware()` in constructors, `authorizeResource()`,
 * `HasMiddleware::middleware()`, and Laravel 13 `#[Middleware]` / `#[Authorize]` / `#[WithoutMiddleware]` attributes.
 */
export class ControllerInspector {
  private decls = new Map<PhpClass, { list: Declaration[]; unknown: { reason: string; text: string }[] }>();
  /** Whether the class or a project parent has any PHP attribute at all (most code has none). */
  private attributed = new Map<PhpClass, boolean>();

  constructor(private index: PhpIndex) {}

  inspect(cls: PhpClass, method: string): ControllerResult {
    const { list, unknown } = this.declarations(cls);
    const middleware: ControllerMiddleware[] = [];
    for (const d of list) {
      const a = d.conditional ? 'maybe' : appliesTo(method, d.only, d.except);
      if (a === 'no') continue;
      const inherited = d.cls === cls ? undefined : d.cls.fqn;
      if (d.closure) {
        middleware.push({ name: null, text: d.names[0]?.text ?? 'closure', file: d.file, line: d.line, applies: a, closure: true, inherited });
        continue;
      }
      for (const n of d.names) middleware.push({ ...n, file: d.file, line: d.line, applies: a, closure: false, inherited });
    }
    // Attributes are merged with constructor / HasMiddleware middleware (Route::controllerMiddleware).
    const attrs = this.attributes(cls, method);
    for (const d of attrs.list) {
      const a = appliesTo(method, d.only, d.except);
      if (a === 'no') continue;
      const inherited = d.cls === cls ? undefined : d.cls.fqn;
      for (const n of d.names) middleware.push({ ...n, file: d.file, line: d.line, applies: a, closure: d.closure, inherited });
    }
    const excluded = attrs.excluded.filter((d) => appliesTo(method, d.only, d.except) !== 'no').flatMap((d) => d.names.map((n) => ({ ...n, file: d.file, line: d.line })));
    return { middleware, excluded, unknown: [...unknown, ...attrs.unknown] };
  }

  /** Middleware attributes on the class, its project parents, and the action method. */
  private attributes(cls: PhpClass, method: string): { list: Declaration[]; excluded: Declaration[]; unknown: { reason: string; text: string }[] } {
    const out = { list: [] as Declaration[], excluded: [] as Declaration[], unknown: [] as { reason: string; text: string }[] };
    const chain: PhpClass[] = [];
    for (let c: PhpClass | null = cls; c && chain.length < 6; c = c.extends[0] ? this.index.findClass(c.extends[0]) : null) chain.push(c);
    let any = this.attributed.get(cls);
    if (any === undefined) {
      any = chain.some((c) => this.index.source(this.index.fileOf(c) ?? '').includes('#['));
      this.attributed.set(cls, any);
    }
    if (!any) return out;
    const owners: { node: SyntaxNode | null; cls: PhpClass }[] = [];
    // Parent class attributes first, as Laravel prepends them while walking up.
    for (const c of chain.reverse()) owners.push({ node: this.index.classNode(c), cls: c });
    const m = this.index.findMethod(cls, method);
    if (m) owners.push({ node: m.node, cls: m.cls });
    for (const { node, cls: owner } of owners) {
      const list = node?.childForFieldName('attributes');
      if (!list) continue;
      const file = this.index.fileOf(owner) ?? '';
      const scope = this.index.scope(file, node!.startIndex);
      for (const a of list.descendantsOfType('attribute')) {
        const written = a.namedChildren[0]?.text ?? '';
        const fqn = scope.resolveClass(written);
        const lower = fqn.toLowerCase();
        const project = this.index.findClass(fqn);
        const kind =
          lower === ATTR_MIDDLEWARE || lower === ATTR_AUTHORIZE || lower === ATTR_WITHOUT
            ? lower
            : project && this.index.isA(project, ATTR_WITHOUT)
              ? 'custom-without'
              : project && (this.index.isA(project, ATTR_MIDDLEWARE) || this.index.isA(project, ATTR_AUTHORIZE))
                ? 'custom'
                : /middleware|authori[sz]e/i.test(written)
                  ? 'unrecognized'
                  : null;
        if (!kind) continue;
        const text = `#[${firstLine(a, 80)}]`;
        if (kind === 'unrecognized' || kind === 'custom-without') {
          out.unknown.push({ reason: 'attribute-middleware', text });
          continue;
        }
        const args = namedArgs(a);
        const arg = (n: string, i: number) => args.find((x) => x.name === n)?.value ?? (args[i] && !args[i].name ? args[i].value : undefined);
        const opt = (n: SyntaxNode | undefined): Methods => (n && n.type !== 'null' ? methodList([n]) : null);
        const base = { closure: false, conditional: false, file, line: a.startPosition.row + 1, cls: owner, only: opt(arg('only', kind === ATTR_AUTHORIZE ? 2 : 1)), except: opt(arg('except', kind === ATTR_AUTHORIZE ? 3 : 2)) };
        if (kind === 'custom') {
          // A project subclass: its constructor may differ, so keep it as an unresolvable middleware.
          out.list.push({ ...base, names: [{ name: null, text }] });
        } else if (kind === ATTR_AUTHORIZE) {
          const ability = arg('ability', 0);
          const models = stringList(arg('models', 1)) ?? [];
          const params = [phpString(ability) ?? ability?.text ?? '?', ...models].join(',');
          out.list.push({ ...base, names: [{ name: `Illuminate\\Auth\\Middleware\\Authorize:${params}`, text: `#[Authorize(${params})]` }] });
        } else {
          const mw = arg('middleware', 0);
          const target = kind === ATTR_WITHOUT ? out.excluded : out.list;
          if (mw && FUNCTION_TYPES.has(mw.type)) target.push({ ...base, closure: true, names: [{ name: null, text }] });
          else target.push({ ...base, names: middlewareNames(mw, scope).map((n) => ({ ...n, text: `#[${kind === ATTR_WITHOUT ? 'WithoutMiddleware' : 'Middleware'}(${n.text})]` })) });
        }
      }
    }
    return out;
  }

  private declarations(cls: PhpClass): { list: Declaration[]; unknown: { reason: string; text: string }[] } {
    let cached = this.decls.get(cls);
    if (cached) return cached;
    cached = this.index.isA(cls, HAS_MIDDLEWARE, 'implements') ? this.staticMiddleware(cls) : this.constructorChain(cls, 0);
    this.decls.set(cls, cached);
    return cached;
  }

  /** Constructor middleware, following `parent::__construct()` (or an inherited constructor) up the project's classes. */
  private constructorChain(cls: PhpClass, depth: number): { list: Declaration[]; unknown: { reason: string; text: string }[] } {
    const ctor = this.index.methodNode(cls, '__construct');
    const own = ctor ? this.fromConstructor(cls, ctor) : [];
    const callsParent =
      !ctor ||
      (/parent\s*::\s*__construct/i.test(ctor.text) &&
        ctor.descendantsOfType('scoped_call_expression').some((c) => c.childForFieldName('scope')?.text === 'parent' && c.childForFieldName('name')?.text === '__construct'));
    const parentName = cls.extends[0];
    if (!callsParent || !parentName || FRAMEWORK_CONTROLLERS.has(parentName.toLowerCase()) || depth >= 4) return { list: own, unknown: [] };
    const parent = this.index.findClass(parentName);
    if (!parent) return { list: own, unknown: [{ reason: 'parent-controller-not-scanned', text: `${cls.name} extends ${parentName}` }] };
    const up = this.constructorChain(parent, depth + 1);
    return { list: [...up.list, ...own], unknown: up.unknown };
  }

  private fromConstructor(cls: PhpClass, ctor: SyntaxNode): Declaration[] {
    const file = this.index.fileOf(cls) ?? '';
    const scope = this.index.scope(file, this.index.classNode(cls)?.startIndex ?? 0);
    const body = ctor.childForFieldName('body');
    if (!body || !/->\s*(middleware|authorizeResource)\s*\(/.test(body.text)) return [];
    const out: Declaration[] = [];
    for (const call of thisCalls(body)) {
      const name = call.childForFieldName('name')?.text;
      const obj = call.childForFieldName('object');
      if ((name !== 'middleware' && name !== 'authorizeResource') || obj?.type !== 'variable_name' || obj.text !== '$this') continue;
      // `$this->middleware()` inside a closure runs per request, after middleware was gathered.
      if (enclosing(call, FUNCTION_TYPES, body)) continue;
      const conditional = enclosing(call, CONDITIONAL_TYPES, body) !== null;
      const args = argsOf(call);
      let only: Methods = null;
      let except: Methods = null;
      // ->only([...]) / ->except([...]) chained on the call.
      for (let cur = call, p = call.parent; p?.type === 'member_call_expression' && p.childForFieldName('object')?.id === cur.id; cur = p, p = p.parent) {
        const m = p.childForFieldName('name')?.text;
        if (m === 'only') only = methodList(argsOf(p));
        else if (m === 'except') except = methodList(argsOf(p));
        else break;
      }
      const optionsArg = name === 'middleware' ? args[1] : args[2];
      if (optionsArg) {
        const opts = arrayAttributes(optionsArg);
        if (optionsArg.type !== 'array_creation_expression') only = '?';
        if (opts.has('only')) only = methodList([opts.get('only')!]);
        if (opts.has('except')) except = methodList([opts.get('except')!]);
      }
      const line = call.startPosition.row + 1;
      if (name === 'authorizeResource') {
        out.push(...this.authorizeResource(cls, args, only, except, conditional, file, line));
        continue;
      }
      const first = args[0];
      if (first && FUNCTION_TYPES.has(first.type)) {
        out.push({ names: [{ name: null, text: firstLine(call) }], closure: true, only, except, conditional, file, line, cls });
      } else {
        out.push({ names: middlewareNames(first, scope), closure: false, only, except, conditional, file, line, cls });
      }
    }
    return out;
  }

  /** `authorizeResource(Post::class, 'post')`: one `can:<ability>,<param>` middleware per resource method. */
  private authorizeResource(cls: PhpClass, args: SyntaxNode[], only: Methods, except: Methods, conditional: boolean, file: string, line: number): Declaration[] {
    const scope = this.index.scope(file, this.index.classNode(cls)?.startIndex ?? 0);
    const model = classConstant(args[0], scope) ?? phpString(args[0]);
    // Laravel's default parameter is Str::snake(class_basename($model)).
    const param = phpString(args[1]) ?? (model ? model.split('\\').pop()!.replace(/(?<=[a-z0-9])([A-Z])/g, '_$1').toLowerCase() : null);
    return Object.entries(RESOURCE_ABILITIES).map(([method, ability]) => {
      const subject = WITHOUT_MODELS.has(method) ? model : param;
      const restrictedOnly = only === '?' ? '?' : only ? only.filter((m) => m === method) : [method];
      return {
        names: [{ name: subject ? `can:${ability},${subject}` : null, text: `authorizeResource(): can:${ability} before ${method}()` }],
        closure: false,
        only: restrictedOnly,
        except,
        conditional,
        file,
        line,
        cls,
      };
    });
  }

  /** Laravel 11+ `public static function middleware(): array` on HasMiddleware controllers. */
  private staticMiddleware(cls: PhpClass): { list: Declaration[]; unknown: { reason: string; text: string }[] } {
    const found = this.index.findMethod(cls, 'middleware');
    if (!found) return { list: [], unknown: [] };
    const { node, file } = found;
    const scope = this.index.scope(file, node.startIndex);
    const body = node.childForFieldName('body');
    const ret = body?.descendantsOfType('return_statement').find((r) => !enclosing(r, FUNCTION_TYPES, body));
    const value = ret?.namedChildren[0];
    const line = (n: SyntaxNode) => n.startPosition.row + 1;
    const base = { only: null, except: null, conditional: false, file, cls: found.cls };
    if (!value || value.type !== 'array_creation_expression') {
      return { list: [{ ...base, names: [{ name: null, text: 'middleware() does not return a literal array' }], closure: false, conditional: true, line: line(node) }], unknown: [] };
    }
    const list: Declaration[] = [];
    for (const el of value.namedChildren) {
      if (el.type !== 'array_element_initializer') continue;
      const v = el.namedChildren[el.namedChildren.length - 1];
      if (FUNCTION_TYPES.has(v.type)) {
        list.push({ ...base, names: [{ name: null, text: firstLine(v) }], closure: true, line: line(v) });
        continue;
      }
      if (v.type === 'object_creation_expression') {
        const clsName = v.namedChildren.find((c) => c.type === 'name' || c.type === 'qualified_name')?.text;
        if (clsName && scope.resolveClass(clsName).toLowerCase() === CONTROLLER_MIDDLEWARE) {
          const args = namedArgs(v);
          const arg = (n: string, i: number) => args.find((a) => a.name === n)?.value ?? (args[i] && !args[i].name ? args[i].value : undefined);
          const mw = arg('middleware', 0);
          const onlyNode = arg('only', 1);
          const exceptNode = arg('except', 2);
          const only = onlyNode && onlyNode.type !== 'null' ? methodList([onlyNode]) : null;
          const except = exceptNode && exceptNode.type !== 'null' ? methodList([exceptNode]) : null;
          if (mw && FUNCTION_TYPES.has(mw.type)) list.push({ ...base, names: [{ name: null, text: firstLine(v) }], closure: true, only, except, line: line(v) });
          else list.push({ ...base, names: middlewareNames(mw, scope), closure: false, only, except, line: line(v) });
          continue;
        }
      }
      list.push({ ...base, names: middlewareNames(v, scope), closure: false, line: line(v) });
    }
    return { list, unknown: [] };
  }
}
