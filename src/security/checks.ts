import type { PhpClass } from '../lang/php/extract.js';
import type { PhpScope } from '../lang/php/names.js';
import { phpString } from '../lang/php/names.js';
import type { SyntaxNode } from '../parse.js';
import type { PhpIndex } from './php.js';
import { firstLine } from './php.js';
import type { Confidence } from './types.js';

// A short list of local, single-function pattern checks. Each favours precision over coverage;
// nothing follows data across functions. Rules that Semgrep or ESLint already do as well are left out.

export interface CheckRule {
  id: string;
  side: 'backend' | 'frontend';
  title: string;
  description: string;
}

export const CHECK_RULES: CheckRule[] = [
  {
    id: 'laravel.mass-assignment',
    side: 'backend',
    title: 'Mass assignment from all request input',
    description:
      "All request input ($request->all(), input(), except()) reaches forceFill/forceCreate/insert/upsert (which ignore $fillable and $guarded), or create/update/fill on a model whose $guarded is []. Calls on models CodeMap cannot resolve are not flagged.",
  },
  {
    id: 'laravel.raw-sql-request-input',
    side: 'backend',
    title: 'Request input inside raw SQL',
    description:
      'A request value is interpolated or concatenated into DB::raw/select/statement/... or a *Raw() query method in the same function. Values cast to int, and bound parameters (?), are not flagged.',
  },
  {
    id: 'react.dangerously-set-inner-html',
    side: 'frontend',
    title: 'dangerouslySetInnerHTML with an unsanitized value',
    description: 'The __html value is not a literal, a JSON serializer (JSON.stringify, serializeJsonLd...), or a call to a recognizable sanitizer (DOMPurify, sanitize-html, xss).',
  },
  {
    id: 'js.token-in-web-storage',
    side: 'frontend',
    title: 'Auth token in localStorage / sessionStorage',
    description: 'A token-like key is written to web storage, where any script on the page (including injected ones) can read it.',
  },
  {
    id: 'next.public-env-secret',
    side: 'frontend',
    title: 'Secret-looking NEXT_PUBLIC_ variable',
    description: 'NEXT_PUBLIC_* values are inlined into the browser bundle at build time; a name containing SECRET, PRIVATE, PASSWORD or SERVICE_ROLE suggests it should not be.',
  },
];

/** Considered and left out, with the reason (shown in the report). */
export const SKIPPED_RULES = [
  { id: 'eval / new Function', why: 'ESLint (no-eval, no-new-func) and Semgrep catch these exactly; CodeMap has no framework context to add.' },
];

export interface CheckHit {
  ruleId: string;
  side: 'backend' | 'frontend';
  file: string;
  line: number;
  endLine: number;
  message: string;
  confidence: Confidence;
}

const lineOf = (n: SyntaxNode) => n.startPosition.row + 1;
const endOf = (n: SyntaxNode) => n.endPosition.row + 1;

// ---------------------------------------------------------------------------------------------
// PHP

const PHP_FUNCTIONS = new Set(['method_declaration', 'function_definition', 'anonymous_function', 'arrow_function']);
const SUPERGLOBALS = new Set(['$_GET', '$_POST', '$_REQUEST', '$_COOKIE']);
/** Request methods that return every input field. */
const ALL_INPUT = new Set(['all', 'except']);
const NO_ARG_ALL = new Set(['input', 'post', 'json']);
/** Request methods that read user input. */
const READS = new Set(['all', 'except', 'only', 'input', 'get', 'query', 'post', 'json', 'string', 'str', 'header', 'cookie', 'route', 'collect', 'fluent']);
const MASS_ALWAYS = new Set(['forcefill', 'forcecreate', 'forcecreatequietly', 'insert', 'upsert']);
const MASS_GUARDED = new Set(['create', 'update', 'fill', 'make', 'firstorcreate', 'firstornew', 'updateorcreate', 'createquietly']);
const DB_RAW = new Set(['raw', 'select', 'selectone', 'selectresultsets', 'statement', 'unprepared', 'insert', 'update', 'delete', 'affectingstatement', 'scalar', 'cursor']);
const RAW_METHODS = new Set(['whereraw', 'orwhereraw', 'havingraw', 'orhavingraw', 'orderbyraw', 'selectraw', 'groupbyraw', 'fromraw', 'joinraw']);
const INT_CASTS = /^\(\s*(int|integer|float|double|bool|boolean)\s*\)/i;

interface FnCtx {
  fn: SyntaxNode;
  /** Typed parameters: variable name -> written class name. */
  params: Map<string, string>;
  /** Local variable -> right-hand sides assigned to it in this function. */
  assigned: Map<string, SyntaxNode[]>;
}

function fnContext(fn: SyntaxNode, cache: Map<number, FnCtx>): FnCtx {
  let ctx = cache.get(fn.id);
  if (ctx) return ctx;
  const params = new Map<string, string>();
  for (const p of fn.childForFieldName('parameters')?.namedChildren ?? []) {
    const name = p.childForFieldName('name')?.text;
    const type = p.childForFieldName('type');
    const named = type?.type === 'named_type' ? type.namedChildren[0]?.text : type?.type === 'optional_type' ? type.namedChildren[0]?.namedChildren[0]?.text : undefined;
    if (name && named) params.set(name, named);
  }
  const assigned = new Map<string, SyntaxNode[]>();
  const body = fn.childForFieldName('body');
  for (const a of body?.descendantsOfType('assignment_expression') ?? []) {
    if (nearestFn(a)?.id !== fn.id) continue; // tree-sitter returns new wrapper objects: compare ids
    const left = a.childForFieldName('left');
    const right = a.childForFieldName('right');
    if (left?.type !== 'variable_name' || !right) continue;
    const list = assigned.get(left.text) ?? [];
    list.push(right);
    assigned.set(left.text, list);
  }
  ctx = { fn, params, assigned };
  cache.set(fn.id, ctx);
  return ctx;
}

function nearestFn(n: SyntaxNode): SyntaxNode | null {
  for (let p = n.parent; p; p = p.parent) if (PHP_FUNCTIONS.has(p.type)) return p;
  return null;
}

/** `$request`, a parameter typed *Request, or `request()`. */
function isRequestObject(n: SyntaxNode | null, ctx: FnCtx): boolean {
  if (!n) return false;
  if (n.type === 'variable_name') return n.text === '$request' || /Request$/.test(ctx.params.get(n.text) ?? '');
  if (n.type === 'function_call_expression') return n.childForFieldName('function')?.text === 'request' && !(n.childForFieldName('arguments')?.namedChildren.length);
  return false;
}

/** `Request::input()` through the facade (or the global `Request` alias), not static calls on Illuminate\Http\Request. */
function isRequestFacade(scopeNode: SyntaxNode | null, scope: PhpScope): boolean {
  if (!scopeNode) return false;
  const fqn = scope.resolveClass(scopeNode.text).toLowerCase();
  return fqn === 'illuminate\\support\\facades\\request' || fqn === 'request';
}

/** Does this expression read user input? 'all' when it is every field. */
function requestRead(n: SyntaxNode, ctx: FnCtx, scope: PhpScope): 'all' | 'value' | null {
  if (n.type === 'member_call_expression' || n.type === 'nullsafe_member_call_expression') {
    const name = n.childForFieldName('name')?.text.toLowerCase() ?? '';
    const obj = n.childForFieldName('object');
    if (!isRequestObject(obj, ctx) || !READS.has(name)) return null;
    const argc = n.childForFieldName('arguments')?.namedChildren.length ?? 0;
    return ALL_INPUT.has(name) || (NO_ARG_ALL.has(name) && argc === 0) ? 'all' : 'value';
  }
  if (n.type === 'scoped_call_expression' && isRequestFacade(n.childForFieldName('scope'), scope)) {
    const name = n.childForFieldName('name')?.text.toLowerCase() ?? '';
    if (!READS.has(name)) return null;
    const argc = n.childForFieldName('arguments')?.namedChildren.length ?? 0;
    return ALL_INPUT.has(name) || (NO_ARG_ALL.has(name) && argc === 0) ? 'all' : 'value';
  }
  if (n.type === 'function_call_expression' && n.childForFieldName('function')?.text === 'request') {
    return (n.childForFieldName('arguments')?.namedChildren.length ?? 0) > 0 ? 'value' : null;
  }
  if (n.type === 'member_access_expression' && isRequestObject(n.childForFieldName('object'), ctx)) return 'value'; // $request->email
  if (n.type === 'subscript_expression' && SUPERGLOBALS.has(n.namedChildren[0]?.text ?? '')) return 'value';
  return null;
}

/** Strongest request read inside an expression (or through a local variable assigned in the same function). */
function containsRead(n: SyntaxNode, ctx: FnCtx, scope: PhpScope, want: 'all' | 'value', viaLocal = true): { node: SyntaxNode; local: boolean } | null {
  const stack = [n];
  while (stack.length) {
    const x = stack.pop()!;
    if (INT_CASTS.test(x.text) && x.type === 'cast_expression') continue;
    if (x.type === 'function_call_expression' && /^(intval|floatval|abs|count|is_numeric|e|htmlspecialchars)$/.test(x.childForFieldName('function')?.text ?? '')) continue;
    const r = requestRead(x, ctx, scope);
    if (r && (want === 'value' || r === 'all')) return { node: x, local: false };
    if (r) continue;
    if (viaLocal && x.type === 'variable_name' && ctx.assigned.has(x.text)) {
      for (const rhs of ctx.assigned.get(x.text)!) if (containsRead(rhs, ctx, scope, want, false)) return { node: x, local: true };
    }
    stack.push(...x.namedChildren);
  }
  return null;
}

/** `$guarded = []` on the class or a project ancestor (searched until a declaration is found). */
function unguarded(cls: PhpClass, index: PhpIndex): 'unguarded' | 'guarded' | 'unknown' {
  let cur: PhpClass | null = cls;
  for (let depth = 0; cur && depth < 6; depth++) {
    const body = index.classNode(cur)?.childForFieldName('body');
    for (const decl of body?.namedChildren ?? []) {
      if (decl.type !== 'property_declaration') continue;
      for (const el of decl.descendantsOfType('property_element')) {
        if (el.namedChildren.find((c) => c.type === 'variable_name')?.text !== '$guarded') continue;
        const v = el.childForFieldName('default_value') ?? el.namedChildren.find((c) => c.type === 'array_creation_expression');
        return v?.type === 'array_creation_expression' && !v.namedChildren.some((c) => c.type === 'array_element_initializer') ? 'unguarded' : 'guarded';
      }
    }
    const parent: string | undefined = cur.extends[0];
    if (!parent) break;
    if (parent.toLowerCase() === 'illuminate\\database\\eloquent\\model') return 'guarded';
    cur = index.findClass(parent);
  }
  return cur ? 'guarded' : 'unknown';
}

/** Interpolated or concatenated pieces of a SQL string argument. */
function sqlPieces(arg: SyntaxNode): SyntaxNode[] {
  if (arg.type === 'encapsed_string' || arg.type === 'heredoc') {
    return arg.descendantsOfType(['variable_name', 'member_access_expression', 'member_call_expression', 'subscript_expression', 'function_call_expression', 'scoped_call_expression']).filter((n) => {
      // keep outermost expressions only
      for (let p = n.parent; p && p.id !== arg.id; p = p.parent) if (p.type !== 'heredoc_body' && p.type !== 'string_content') return false;
      return true;
    });
  }
  if (arg.type === 'binary_expression' && arg.children.find((c) => !c.isNamed)?.text === '.') {
    return [...sqlPieces(arg.childForFieldName('left')!), ...sqlPieces(arg.childForFieldName('right')!)];
  }
  if (arg.type === 'function_call_expression' && arg.childForFieldName('function')?.text === 'sprintf') {
    return (arg.childForFieldName('arguments')?.namedChildren ?? []).slice(1).map((a) => a.namedChildren[a.namedChildren.length - 1]).filter(Boolean);
  }
  if (arg.type === 'string' || phpString(arg) !== null) return [];
  return [arg];
}

const firstArg = (call: SyntaxNode) => {
  const a = call.childForFieldName('arguments')?.namedChildren.find((x) => x.type === 'argument');
  return a ? a.namedChildren[a.namedChildren.length - 1] : undefined;
};
const allArgs = (call: SyntaxNode) =>
  (call.childForFieldName('arguments') ?? call.namedChildren.find((c) => c.type === 'arguments'))?.namedChildren.filter((x) => x.type === 'argument').map((a) => a.namedChildren[a.namedChildren.length - 1]) ?? [];

/** Cheap text tests per rule: a file is only walked when it could contain a hit. */
const MASS_TEXT = /(->|::)\s*(all|except)\s*\(|->\s*(input|post|json)\s*\(\s*\)/;
const RAW_TEXT = /Raw\s*\(|DB::/;
/** Call sites worth a look, found in the source text and then looked up in the tree (much cheaper than walking every call). */
const MASS_CALL = /(?:->|::)\s*(forceFill|forceCreate|forceCreateQuietly|insert|upsert|create|createQuietly|update|fill|make|firstOrCreate|firstOrNew|updateOrCreate)\s*\(|\bnew\s+\\?[A-Za-z_][\w\\]*\s*\(/gi;
const RAW_CALL = /(?:->|::)\s*(raw|select|selectOne|selectResultSets|statement|unprepared|insert|update|delete|affectingStatement|scalar|cursor|whereRaw|orWhereRaw|havingRaw|orHavingRaw|orderByRaw|selectRaw|groupByRaw|fromRaw|joinRaw)\s*\(/gi;
const CALL_TYPES = new Set(['member_call_expression', 'nullsafe_member_call_expression', 'scoped_call_expression', 'object_creation_expression']);

function candidateCalls(root: SyntaxNode, source: string, patterns: RegExp[]): SyntaxNode[] {
  const out = new Map<number, SyntaxNode>();
  for (const re of patterns) {
    re.lastIndex = 0;
    for (let m = re.exec(source); m; m = re.exec(source)) {
      // Climb from the name (or `new`) to the call expression it belongs to.
      const at = m.index + m[0].search(/[A-Za-z]/);
      for (let n: SyntaxNode | null = root.descendantForIndex(at); n; n = n.parent) {
        if (CALL_TYPES.has(n.type)) {
          out.set(n.id, n);
          break;
        }
        if (n.type.endsWith('_statement') || n.type === 'compound_statement') break;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.startIndex - b.startIndex);
}

export function phpChecks(files: Map<string, { root: SyntaxNode; source: string }>, index: PhpIndex): CheckHit[] {
  const hits: CheckHit[] = [];
  for (const [rel, { root, source }] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!rel.endsWith('.php')) continue;
    const mass = MASS_TEXT.test(source);
    const raw = RAW_TEXT.test(source);
    if (!mass && !raw) continue;
    const ctxCache = new Map<number, FnCtx>();
    for (const call of candidateCalls(root, source, [...(mass ? [MASS_CALL] : []), ...(raw ? [RAW_CALL] : [])])) {
      const name = (call.type === 'object_creation_expression' ? '__new' : call.childForFieldName('name')?.text ?? '').toLowerCase();
      const isDb = call.type === 'scoped_call_expression' && /^\\?(DB|Illuminate\\Support\\Facades\\DB)$/.test(call.childForFieldName('scope')?.text ?? '');
      const massCandidate = mass && !isDb && (MASS_ALWAYS.has(name) || MASS_GUARDED.has(name) || name === '__new');
      const isDbRaw = raw && isDb && DB_RAW.has(name);
      const isRaw = raw && call.type !== 'scoped_call_expression' && RAW_METHODS.has(name);
      if (!massCandidate && !isDbRaw && !isRaw) continue;
      const fn = nearestFn(call);
      if (!fn) continue;
      const ctx = fnContext(fn, ctxCache);
      const scope = index.scope(rel, call.startIndex);
      const hit = (ruleId: string, message: string, confidence: Confidence) =>
        hits.push({ ruleId, side: 'backend', file: rel, line: lineOf(call), endLine: endOf(call), message, confidence });

      // Mass assignment (DB::insert() etc. are raw SQL with bindings, handled below)
      if (massCandidate) {
        const input = allArgs(call)
          .map((a) => containsRead(a, ctx, scope, 'all'))
          .find(Boolean);
        if (input) {
          const what = input.local ? `${input.node.text} (assigned from request input)` : firstLine(input.node, 50);
          if (MASS_ALWAYS.has(name)) {
            hit('laravel.mass-assignment', `${what} is passed to ${call.childForFieldName('name')?.text}(), which ignores $fillable and $guarded.`, input.local ? 'medium' : 'high');
          } else {
            const model = modelOf(call, ctx, scope, index);
            if (model && unguarded(model, index) === 'unguarded') {
              const verb = name === '__new' ? `new ${model.name}()` : `${model.name}::${call.childForFieldName('name')?.text}()`;
              hit('laravel.mass-assignment', `${what} is passed to ${verb}; ${model.name} sets $guarded = [] so every column is fillable.`, input.local ? 'medium' : 'high');
            }
          }
        }
      }

      // Raw SQL
      if (isDbRaw || isRaw) {
        const sql = firstArg(call);
        for (const piece of sql ? sqlPieces(sql) : []) {
          const read = containsRead(piece, ctx, scope, 'value');
          if (!read) continue;
          const label = isDbRaw ? `DB::${call.childForFieldName('name')?.text}()` : `${call.childForFieldName('name')?.text}()`;
          hit(
            'laravel.raw-sql-request-input',
            `${read.local ? `${read.node.text} (assigned from request input)` : firstLine(read.node, 50)} is built into the SQL of ${label}; pass it as a binding (?) instead.`,
            read.local ? 'medium' : 'high',
          );
          break;
        }
      }
    }
  }
  return dedupe(hits);
}

/** The model a create/update/fill call targets: `User::create`, `new User(...)`, or a typed parameter `$user->update`. */
function modelOf(call: SyntaxNode, ctx: FnCtx, scope: PhpScope, index: PhpIndex): PhpClass | null {
  let written: string | undefined;
  if (call.type === 'scoped_call_expression') written = call.childForFieldName('scope')?.text;
  else if (call.type === 'object_creation_expression') written = call.namedChildren.find((c) => c.type === 'name' || c.type === 'qualified_name')?.text;
  else {
    const obj = call.childForFieldName('object');
    if (obj?.type === 'variable_name') written = ctx.params.get(obj.text);
  }
  if (!written || written === 'static' || written === 'self' || written === 'parent') return null;
  return index.findClass(scope.resolveClass(written));
}

// ---------------------------------------------------------------------------------------------
// JS / TS

const SANITIZER = /sanitiz|purif|dompurify|xss|escape/i;
/** JSON serializers (JSON.stringify, serializeJsonLd, toJsonLd...): JSON-LD script blocks, not markup. */
const JSON_SERIALIZER = /json/i;
const TOKEN_WORDS = new Set(['token', 'jwt', 'bearer', 'auth', 'session', 'apikey', 'secret', 'credential', 'credentials', 'sanctum']);
/** Keys like `analytics_session_id` name tracking state, not credentials. */
const TRACKING_WORDS = new Set(['analytics', 'tracking', 'tracker', 'visitor', 'telemetry', 'metrics', 'utm']);
const PUBLIC_SECRET = /SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE/;
const STORAGE_CALL = /(local|session)Storage\s*\.\s*setItem\s*\(/;
const STORAGE_ASSIGN = /(local|session)Storage\s*(\.\s*\w+|\[[^\]]+\])\s*=[^=]/;
const PUBLIC_SECRET_TEXT = /NEXT_PUBLIC_\w*(SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE)/;

function jsLiteral(n: SyntaxNode | null | undefined): boolean {
  if (!n) return false;
  if (n.type === 'string') return true;
  if (n.type === 'template_string') return !n.namedChildren.some((c) => c.type === 'template_substitution');
  if (n.type === 'parenthesized_expression') return jsLiteral(n.namedChildren[0]);
  // '(function(){' + '...' + '})()': a constant built from literals.
  if (n.type === 'binary_expression' && n.childForFieldName('operator')?.text === '+') {
    return jsLiteral(n.childForFieldName('left')) && jsLiteral(n.childForFieldName('right'));
  }
  return false;
}

/** Whitespace collapsed to single spaces, cut at `max` with an ellipsis. */
function oneLine(n: SyntaxNode, max: number): string {
  const t = n.text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function jsStringValue(n: SyntaxNode | null | undefined): string | null {
  if (!n || !jsLiteral(n)) return null;
  return n.text.slice(1, -1);
}

/** "accessToken" -> ["access", "token"], "auth_token" -> ["auth", "token"]. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const tokenKey = (key: string) => {
  const w = words(key);
  if (w.some((x) => TRACKING_WORDS.has(x))) return false;
  return w.some((x) => TOKEN_WORDS.has(x)) || w.join('') === 'apikey';
};

/** Initializer of a local `const x = ...` with this name in the same file, if any. */
function initOf(root: SyntaxNode, name: string): SyntaxNode | null {
  for (const d of root.descendantsOfType('variable_declarator')) {
    if (d.childForFieldName('name')?.text === name) return d.childForFieldName('value');
  }
  return null;
}

export function jsChecks(files: Map<string, { root: SyntaxNode; source: string }>): CheckHit[] {
  const hits: CheckHit[] = [];
  for (const [rel, { root, source }] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const html = source.includes('dangerouslySetInnerHTML');
    const storageCall = STORAGE_CALL.test(source);
    const storageAssign = STORAGE_ASSIGN.test(source);
    const publicSecret = PUBLIC_SECRET_TEXT.test(source);
    if (!html && !storageCall && !storageAssign && !publicSecret) continue;
    const hit = (ruleId: string, n: SyntaxNode, message: string, confidence: Confidence) =>
      hits.push({ ruleId, side: 'frontend', file: rel, line: lineOf(n), endLine: endOf(n), message, confidence });

    if (html) {
      for (const attr of root.descendantsOfType('jsx_attribute')) {
        if (attr.namedChildren[0]?.text !== 'dangerouslySetInnerHTML') continue;
        const obj = attr.descendantsOfType('object')[0];
        const pair = obj?.namedChildren.find((p) => p.type === 'pair' && p.childForFieldName('key')?.text.replace(/['"]/g, '') === '__html');
        const value = pair?.childForFieldName('value');
        if (!value) continue;
        if (jsLiteral(value)) continue;
        const callee = value.type === 'call_expression' ? value.childForFieldName('function')?.text ?? '' : '';
        if (JSON_SERIALIZER.test(callee) || SANITIZER.test(callee)) continue;
        if (value.type === 'identifier') {
          const init = initOf(root, value.text);
          const initCallee = init?.type === 'call_expression' ? init.childForFieldName('function')?.text ?? '' : '';
          if (jsLiteral(init) || JSON_SERIALIZER.test(initCallee) || SANITIZER.test(initCallee)) continue;
        }
        hit('react.dangerously-set-inner-html', attr, `dangerouslySetInnerHTML renders ${oneLine(value, 50)} as HTML without a recognizable sanitizer.`, 'medium');
      }
    }

    if (storageCall) {
      for (const call of root.descendantsOfType('call_expression')) {
        const fn = call.childForFieldName('function');
        if (fn?.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 'setItem') continue;
        const store = fn.childForFieldName('object')?.text.replace(/^window\./, '');
        if (store !== 'localStorage' && store !== 'sessionStorage') continue;
        const args = call.childForFieldName('arguments')?.namedChildren ?? [];
        const key = jsStringValue(args[0]);
        if (key === null || !tokenKey(key) || jsLiteral(args[1])) continue;
        hit('js.token-in-web-storage', call, `'${key}' is written to ${store}, readable by any script on the page; an HttpOnly cookie (e.g. Sanctum SPA auth) keeps it out of reach.`, 'medium');
      }
    }
    if (storageAssign) {
      for (const asg of root.descendantsOfType('assignment_expression')) {
        const left = asg.childForFieldName('left');
        const obj = left?.childForFieldName('object')?.text.replace(/^window\./, '');
        if ((obj !== 'localStorage' && obj !== 'sessionStorage') || jsLiteral(asg.childForFieldName('right'))) continue;
        const key = left?.type === 'member_expression' ? left.childForFieldName('property')?.text : jsStringValue(left?.childForFieldName('index'));
        if (key && tokenKey(key)) hit('js.token-in-web-storage', asg, `'${key}' is written to ${obj}, readable by any script on the page.`, 'medium');
      }
    }

    if (publicSecret) {
      const seen = new Set<string>();
      for (const m of root.descendantsOfType(['member_expression', 'subscript_expression'])) {
        const obj = m.childForFieldName('object')?.text;
        if (obj !== 'process.env' && obj !== 'import.meta.env') continue;
        const name = m.type === 'member_expression' ? m.childForFieldName('property')?.text : jsStringValue(m.childForFieldName('index'));
        if (!name?.startsWith('NEXT_PUBLIC_') || !PUBLIC_SECRET.test(name) || /PUBLISHABLE/.test(name)) continue;
        const k = `${name}:${lineOf(m)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        hit('next.public-env-secret', m, `${name} looks like a secret, but NEXT_PUBLIC_* values are inlined into the browser bundle.`, 'high');
      }
    }
  }
  return dedupe(hits);
}

function dedupe(hits: CheckHit[]): CheckHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.ruleId}|${h.file}|${h.line}|${h.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
