import type { NextAdapter } from '../lang/js/index.js';
import type { SyntaxNode } from '../parse.js';
import type { Graph } from '../types.js';
import { decide } from './laravel.js';
import { firstLine } from './php.js';
import type { Confidence, ProtectionState, Signal } from './types.js';

// Next.js protection: auth checks in route handlers and server actions (their own code and the
// project helpers they call), and middleware.ts / proxy.ts gates with evaluable path conditions.
// Same rule as for Laravel: anything that could hide a check is "unknown", never "no protection".

const FUNCTION_TYPES = new Set(['function_declaration', 'function_expression', 'arrow_function', 'function', 'generator_function_declaration', 'method_definition']);
const HELPER_DEPTH = 3;

/** Supabase, NextAuth, Clerk, Firebase, jose / jsonwebtoken... */
/** Words an AUTH_MEMBER call must contain: bodies without them skip the call walk. */
const AUTH_MEMBER_WORDS = /getUser|getSession|getClaims|verify/;
const AUTH_MEMBER = /\.auth\.(getUser|getSession|getClaims)$|^(jwt|jsonwebtoken)\.verify$|\.(verifyIdToken|verifySessionCookie)$/;
const AUTH_IDS = new Set(['getServerSession', 'getSession', 'getToken', 'currentUser', 'getAuth', 'auth', 'validateRequest', 'getIronSession', 'verifyIdToken', 'verifySessionCookie', 'jwtVerify']);
/** Only these packages make a bare `auth()` an auth source. */
const AUTH_PACKAGES = /^(next-auth|@auth\/|@clerk\/|@\/auth$|~\/auth$|\.{1,2}\/.*auth)/;
/** Names worth resolving: helpers that read or enforce auth almost always say so. */
const AUTHISH_NAME = /auth|session|user|viewer|account|admin|role|permission|access|token|apikey|credential|signature|login|guard|protect|require|ensure|verify|assert|claims|current|scope/i;
/** Unresolvable helpers credited (at low confidence) only with these name shapes. */
const AUTH_LIKE = /^(get|require|ensure|check|verify|assert|validate|fetch|load)[A-Za-z]*(User|Session|Auth|Admin|Role|Permission|Access|Token|Viewer|Account|Scope|Claims)|^(is|has)(Authenticated|Admin|Role|Permission|Access)|^(requireAuth|withAuth|authenticate|authorize)/;
const ROLE_NAME = /admin|role|permission|access|scope|feature|staff|owner|moderator|can[A-Z]/;
/** A condition that checks roles or permissions. */
const ROLE_COND = /\b(role|roles|appRole|admin|isAdmin|permission|permissions|can[A-Z]\w*|has(Role|Permission|Access|Scope|Feature)\w*|isStaff|isOwner|isSuperuser|isModerator|subrole)\b|\b\w+(Admin|Role|Permission|Privileged|Staff|Owner|Moderator|Superuser)\w*\b/;
/** Explicit failure results that read as a denial (server actions rarely return 401s). */
const FAILURE_RESULT = /\b(success|ok|allowed|authorized)\s*:\s*false\b|\berror\s*:/;
/** Branch exits that deny the request. */
const DENY_CALLS = new Set(['redirect', 'permanentRedirect', 'notFound', 'unauthorized', 'forbidden']);
const DENY_TEXT = /\b40[13]\b|unauthori[sz]ed|unauthenticated|forbidden|denied|\bdeny|reject|not allowed|sign[\s-]?in|log[\s-]?in|redirect/i;
/** Signature / HMAC verification (webhooks, signed requests). */
const SIGNATURE_CHECK = /timingSafeEqual|createHmac\(|crypto\.subtle\.verify|verifyHmac|\.webhooks\.constructEvent|new Webhook\([^)]*\)\.verify/;
const SECRET_COND =
  /headers(\.get\(\s*|\[\s*)['"`](authorization|x-[a-z-]*(secret|token|key|signature)[a-z-]*)['"`]|headers\.authorization\b|\benv\.[A-Z0-9_]*(SECRET|TOKEN|API_KEY|SIGNING)/i;

export interface NextFinding {
  id: string;
  signals: Signal[];
  unknown: { reason: string; text: string }[];
  notes: string[];
}

interface AuthVar {
  via: string;
  kind: 'auth' | 'helper' | 'like';
  role: boolean;
  line: number;
  file: string;
  /** From a helper with a neutral name that reads the session: credited when guarded, never reported when not. */
  weak?: boolean;
  /** From a helper that compares a shared secret or signature, not a session. */
  secret?: boolean;
  /** A flag set from these auth variables: guarding the flag guards them. */
  from?: string[];
  /** From a helper that returns a denial on a failed role test: forwarding its failure is an authorization check. */
  rolePass?: boolean;
}

interface Guard {
  kind: 'authentication' | 'authorization';
  secret: boolean;
  /** The branch clearly denies (401/403, redirect, throw, a failure result); otherwise it only returns early. */
  strong: boolean;
  text: string;
  file: string;
  line: number;
  ifNode: SyntaxNode;
  confidence: Confidence;
  via: string;
}

interface FnResult {
  guards: Guard[];
  /** Statement-level calls to helpers that deny by throwing / redirecting themselves. */
  enforcingCalls: { name: string; role: boolean; file: string; line: number; confidence: Confidence }[];
  /** Auth values read but never used by a denying guard. */
  unguarded: AuthVar[];
  /** Auth-looking helpers that could not be followed and were not guarded. */
  /** `checked`: followed, but what it checks could not be told (it still decides whether the request goes on). */
  unfollowed: { name: string; file: string; line: number; checked?: boolean }[];
  /** For helper classification. */
  readsAuth: boolean;
  deniesByThrow: boolean;
  /** Compares a request header or token with a configured secret (cron / webhook style). */
  checksSecret: boolean;
  /** Not read to the end: a project call past the depth limit, or an auth-named call CodeMap could not read through. */
  opaque: boolean;
  /** Can also hand back nothing (`if (!token) return null`): its caller makes the decision, not this function. */
  softExit: boolean;
  /** Throws when a parameter is missing or fails a role test: `assertAdmin(user)`, `toSession(session)`. */
  paramGuards: { index: number; role: boolean }[];
}

type FnRef = { node: SyntaxNode; file: string };

/**
 * Walk a function body without entering nested functions (callbacks are their own scope). The start
 * node always comes first; below it, only nodes of `types` are built (a cursor walk, which is much
 * cheaper than materializing every child).
 */
function* scope(node: SyntaxNode, types?: ReadonlySet<string>): Generator<SyntaxNode> {
  yield node;
  const c = node.walk();
  if (!c.gotoFirstChild()) return;
  for (;;) {
    let enter = false;
    if (c.nodeIsNamed && !FUNCTION_TYPES.has(c.nodeType)) {
      enter = true;
      if (!types || types.has(c.nodeType)) yield c.currentNode;
    }
    if (enter && c.gotoFirstChild()) continue;
    while (!c.gotoNextSibling()) if (!c.gotoParent()) return;
  }
}

/**
 * scope() as a list, from one native descendantsOfType call: nodes come in document order, so whatever
 * starts before the end of a nested function lies inside it and is dropped.
 */
function scopeOf(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode[] {
  const out = [node];
  let skipUntil = -1;
  for (const n of node.descendantsOfType([...types, ...FUNCTION_TYPES])) {
    if (n.startIndex < skipUntil || (n.startIndex === node.startIndex && n.endIndex === node.endIndex && n.type === node.type)) continue;
    if (FUNCTION_TYPES.has(n.type)) skipUntil = n.endIndex;
    else out.push(n);
  }
  return out;
}

const RESPONSE_DENY = /\.status\(\s*40[13]\s*\)|\.(json|send|end)\([^)]*\b(unauthori[sz]ed|unauthenticated|forbidden)\b/i;

/**
 * Callee names that say they authenticate or authorize. When CodeMap cannot tell what such a function
 * checks but a guard stops the request on its result, the endpoint is unknown, not "no protection".
 * Factories (`createAdminClient`) are left out.
 */
const STRONG_AUTH_NAME = /auth|session|token|login|signin|credential|permission|role|admin|guard|protect|verify|jwt|apikey|currentuser|viewer/i;
const FACTORY_NAME = /^(create|make|new|build|init)|Client$/;
/** Auth APIs that take credentials from the request (login, sign-up, OTP, session exchange): what they decide is known. */
const CREDENTIAL_API = /\.auth\.(signIn\w*|signUp|signOut|verifyOtp|setSession|exchangeCodeForSession|resetPasswordForEmail|refreshSession|resend|updateUser|admin\.\w+|mfa\.\w+)$/;
/** Helpers whose result is the caller's identity: `toSession(...)`, `resolveUser(...)` (not `getScopeForUser(...)`). */
const IDENTITY_NAME = /(?<!For|By|Of|for|by|of)(Session|User|Viewer|Identity|Principal|Actor|Claims|Auth)$|^(session|user|viewer|identity|auth)$/;
const ENFORCING_PREFIX = /^(require|ensure|assert|verify|check|validate|authorize|authenticate|protect|guard)/;

/** A branch without any of these words cannot stop the request. */
const DENY_WORDS = /\b(throw|return|redirect|permanentRedirect|notFound|unauthorized|forbidden)\b/;
const DENY_NODES = new Set(['throw_statement', 'call_expression', 'return_statement']);
const RETURN_NODES = new Set(['return_statement']);
const BODY_NODES = new Set(['variable_declarator', 'assignment_expression', 'expression_statement', 'return_statement', 'if_statement', 'try_statement']);
const CALL_NODES = new Set(['call_expression']);
const COMPARE_NODES = new Set(['binary_expression']);

const unwrapAwait = (n: SyntaxNode | null): SyntaxNode | null => {
  let cur = n;
  while (cur && (cur.type === 'await_expression' || cur.type === 'parenthesized_expression' || cur.type === 'non_null_expression' || cur.type === 'as_expression')) cur = cur.namedChildren[0] ?? null;
  return cur;
};

/** Names bound by a declarator pattern: `user`, `{ data: { user }, error }`, `[a, b]`. */
function boundNames(pattern: SyntaxNode | null): string[] {
  if (!pattern) return [];
  if (pattern.type === 'identifier' || pattern.type === 'shorthand_property_identifier_pattern') return [pattern.text];
  return pattern.namedChildren.flatMap((c) => {
    if (c.type === 'pair_pattern') return boundNames(c.childForFieldName('value'));
    if (c.type === 'object_assignment_pattern' || c.type === 'assignment_pattern') return boundNames(c.childForFieldName('left') ?? c.namedChildren[0]);
    return boundNames(c);
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `\bname\b`, compiled once per name. */
const wordRes = new Map<string, RegExp>();
const wordRe = (name: string): RegExp => {
  let re = wordRes.get(name);
  if (!re) wordRes.set(name, (re = new RegExp(`\\b${escapeRe(name)}\\b`)));
  return re;
};

/** Calls whose result is returned: `f()`, `await f()`, `a ? f() : g()`, `f() ?? g()`. */
function returnedCalls(expr: SyntaxNode | null): SyntaxNode[] {
  const e = unwrapAwait(expr);
  if (!e) return [];
  if (e.type === 'call_expression') return [e];
  if (e.type === 'ternary_expression') return [...returnedCalls(e.childForFieldName('consequence')), ...returnedCalls(e.childForFieldName('alternative'))];
  if (e.type === 'binary_expression' && /^(\|\||\?\?|&&)$/.test(e.childForFieldName('operator')?.text ?? '')) {
    return [...returnedCalls(e.childForFieldName('left')), ...returnedCalls(e.childForFieldName('right'))];
  }
  return [];
}

/** Does the condition test that `name` is missing (`!user`, `!isOk(session)`, `user == null`, `!user?.id`)? */
function absenceOf(cond: string, name: string): boolean {
  const v = escapeRe(name);
  return new RegExp(
    `!\\s*\\(?\\s*(await\\s+)?${v}(\\??\\.\\w+)*(?!\\s*[\\w.?(\\[])|!\\s*[\\w.]+\\(\\s*${v}\\b|\\b${v}(\\??\\.\\w+)*\\s*===?\\s*(null|undefined|false)\\b|\\b(null|undefined)\\s*===?\\s*${v}\\b`,
  ).test(cond);
}

/**
 * Does the condition test that `name` reports a failure: `guard.error`, `result.response`,
 * `res instanceof Response`, `'error' in guard`?
 */
function failureOf(cond: string, name: string): boolean {
  const v = escapeRe(name);
  return new RegExp(
    `(^|[^!.\\w])\\(?\\s*${v}\\??\\.(error|response|denied|unauthorized|forbidden)\\b(?!\\s*(===?|!==?))|\\b${v}\\s+instanceof\\s+(Next)?Response\\b|['"](error|response)['"]\\s+in\\s+${v}\\b`,
  ).test(cond);
}

/** A failed role / permission test: `!isAdmin(u)`, `role !== 'admin'`, `!['a', 'b'].includes(role)` (not `role === 'admin'`). */
const ROLE_TERM = '(role|Role|admin|Admin|permission|Permission|can[A-Z]|has(Role|Permission|Access|Scope|Feature)|isStaff|Owner|Privileged|Moderator|Superuser|subrole|ROLES?|ADMINS?|PERMISSIONS?)';
const ROLE_NEGATIVE = new RegExp(
  `!\\s*\\(?\\s*(await\\s+)?[\\w.]*${ROLE_TERM}|${ROLE_TERM}\\w*\\s*!==?|!==?\\s*['"\`][\\w-]*(admin|role)|!\\s*\\[[^\\]]*\\]\\s*\\.\\s*includes\\(|!\\s*[\\w.]+\\.(includes|some|has)\\([^)]*${ROLE_TERM}`,
);

/** Functions whose name says they test a permission: `canAccessModule`, `isPlatformAdmin`, `hasRole`. */
const PERMISSION_FN = /^can[A-Z]|^has(Role|Permission|Access|Scope|Feature)|Admin|Role|Permission|Access|Staff|Owner|Moderator|Superuser|Privileged/;

/** getUser().catch(() => null), getUser().then(...): the call that matters is the inner one. */
function innerCall(call: SyntaxNode): SyntaxNode {
  let fn = calleeOf(call);
  while (fn?.type === 'member_expression' && /^(catch|then|finally)$/.test(fn.childForFieldName('property')?.text ?? '')) {
    const inner = unwrapAwait(fn.childForFieldName('object'));
    if (inner?.type !== 'call_expression') break;
    call = inner;
    fn = calleeOf(inner);
  }
  return call;
}

/** An auth-named call CodeMap could not classify: `shadowAuth(...)`, `AuthService.check(...)`. */
function strongAuthCall(call: SyntaxNode): string | null {
  const c = innerCall(call);
  const name = calleeName(c);
  const text = calleeOf(c)?.text.replace(/\s+/g, '') ?? name;
  return STRONG_AUTH_NAME.test(name) && !FACTORY_NAME.test(name) && !CREDENTIAL_API.test(text) ? text : null;
}

/** The callee. `await x.m<T>()` parses with the await inside the function position: look past it. */
const calleeOf = (call: SyntaxNode): SyntaxNode | null => unwrapAwait(call.childForFieldName('function'));

function calleeName(call: SyntaxNode): string {
  const fn = calleeOf(call);
  if (!fn) return '';
  if (fn.type === 'member_expression') return fn.childForFieldName('property')?.text ?? '';
  return fn.text;
}

export class NextSecurity {
  private fnCache = new Map<string, FnResult>();
  private walks = new WeakMap<object, Map<string, SyntaxNode[]>>();
  private helperCache = new Map<string, FnRef | null>();
  private topLevelCache = new Map<string, Map<string, SyntaxNode[]>>();
  private dynamicCache = new Map<string, Map<string, { spec: string; exported: string }>>();
  private nextAuthCache = new Map<string, boolean>();

  constructor(
    private next: NextAdapter,
    private graph: Graph,
  ) {}

  private tree(rel: string): SyntaxNode | null {
    return this.next.parsed.get(rel)?.tree.rootNode ?? null;
  }

  /** The function node of a definition (`fe:file#key`), via the nodes kept during extraction. */
  defFunction(file: string, key: string): FnRef | null {
    const info = this.next.infos.get(file);
    const def = info?.defs.find((d) => d.key === key);
    let n = def ? (info!.nodes.get(def) ?? null) : null;
    if (!n) return null;
    // Declarators, pairs and fields hold the function in their value.
    for (let i = 0; i < 3 && n && !FUNCTION_TYPES.has(n.type); i++) {
      const v: SyntaxNode | null = n.childForFieldName('value') ?? n.namedChildren.find((c) => FUNCTION_TYPES.has(c.type) || c.type === 'call_expression') ?? null;
      n = v?.type === 'call_expression' ? this.unwrapCallToFunction(v) : v;
    }
    return n && FUNCTION_TYPES.has(n.type) ? { node: n, file } : null;
  }

  /** `cache(async function x() {})`, `memo(() => ...)`: the function inside a wrapper call. */
  private unwrapCallToFunction(call: SyntaxNode): SyntaxNode | null {
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    return args.find((a) => FUNCTION_TYPES.has(a.type)) ?? null;
  }

  /** A module-level `const NAME = <function | wrapper(function)>` in a file. */
  private moduleFunction(file: string, name: string): FnRef | null {
    for (const d of this.topLevel(file).get(name) ?? []) {
      if (d.type === 'function_declaration' || d.type === 'generator_function_declaration') return { node: d, file };
      const v = unwrapAwait(d.childForFieldName('value'));
      if (v && FUNCTION_TYPES.has(v.type)) return { node: v, file };
      if (v?.type === 'call_expression') {
        const fn = this.unwrapCallToFunction(v);
        if (fn) return { node: fn, file };
        // cache(resolveContext): the wrapped function is passed by name.
        const ident = v.childForFieldName('arguments')?.namedChildren.find((a) => a.type === 'identifier');
        if (ident && ident.text !== name) return this.resolveHelper(file, ident.text);
      }
    }
    return null;
  }

  /** Module-level functions and declarators by name, in document order, indexed once per file. */
  private topLevel(file: string): Map<string, SyntaxNode[]> {
    let index = this.topLevelCache.get(file);
    if (index) return index;
    index = new Map();
    this.topLevelCache.set(file, index);
    const add = (name: string | undefined, n: SyntaxNode) => {
      if (name) index!.set(name, [...(index!.get(name) ?? []), n]);
    };
    for (const top of this.tree(file)?.namedChildren ?? []) {
      const decl = top.type === 'export_statement' ? (top.childForFieldName('declaration') ?? top.namedChildren[0]) : top;
      if (!decl) continue;
      if (decl.type === 'function_declaration' || decl.type === 'generator_function_declaration') add(decl.childForFieldName('name')?.text, decl);
      if (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration') continue;
      for (const d of decl.namedChildren) if (d.type === 'variable_declarator') add(d.childForFieldName('name')?.text, d);
    }
    return index;
  }

  /** scope(), remembered: a helper body is read once per depth it is reached at, and branches once per guard pass. */
  private nodesIn(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode[] {
    let perTree = this.walks.get(node.tree);
    if (!perTree) this.walks.set(node.tree, (perTree = new Map()));
    const key = `${node.startIndex}:${node.endIndex}:${types === BODY_NODES ? 'b' : types === DENY_NODES ? 'd' : types === CALL_NODES ? 'c' : types === COMPARE_NODES ? 'x' : 'r'}`;
    let out = perTree.get(key);
    if (!out) perTree.set(key, (out = scopeOf(node, types)));
    return out;
  }

  /**
   * NextAuth v5 (Auth.js): `export const { auth, handlers } = NextAuth({...})` in a project file. That `auth()`
   * is the library's session API and `handlers` its own route, wherever they are imported from.
   */
  nextAuthBinding(file: string, name: string): boolean {
    const t = this.next.resolveName(file, name);
    const where = t?.kind === 'value' ? { file: t.file, name: t.name } : t ? null : { file, name };
    if (!where) return false;
    const key = `${where.file}\u0000${where.name}`;
    let found = this.nextAuthCache.get(key);
    if (found === undefined) {
      found = false;
      for (const top of this.tree(where.file)?.namedChildren ?? []) {
        const decl = top.type === 'export_statement' ? (top.childForFieldName('declaration') ?? top.namedChildren[0]) : top;
        for (const d of decl?.type === 'lexical_declaration' || decl?.type === 'variable_declaration' ? decl.namedChildren : []) {
          const value = unwrapAwait(d.childForFieldName('value'));
          const callee = value?.type === 'call_expression' ? calleeOf(value) : null;
          if (d.type !== 'variable_declarator' || callee?.type !== 'identifier' || !boundNames(d.childForFieldName('name')).includes(where.name)) continue;
          found ||= /^(next-auth|@auth\/)/.test(this.importSource(where.file, callee.text) ?? '');
        }
      }
      this.nextAuthCache.set(key, found);
    }
    return found;
  }

  /** The project function a callee names: `helper`, or `Service.method` / `obj.method` on a project class or object. */
  resolveCallee(file: string, fn: SyntaxNode): FnRef | null {
    if (fn.type === 'identifier') return this.resolveHelper(file, fn.text);
    const obj = fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
    const prop = fn.childForFieldName('property')?.text;
    if (obj?.type !== 'identifier' || !prop) return null;
    const key = `${file}\u0000${obj.text}.${prop}`;
    if (this.helperCache.has(key)) return this.helperCache.get(key)!;
    const t = this.next.resolveName(file, obj.text);
    const out = t?.kind === 'def' ? this.defFunction(t.file, `${t.key}.${prop}`) : null;
    this.helperCache.set(key, out);
    return out;
  }

  /** Follow an identifier used in `file` to the project function it names. */
  resolveHelper(file: string, name: string): FnRef | null {
    const key = `${file}\u0000${name}`;
    if (this.helperCache.has(key)) return this.helperCache.get(key)!;
    this.helperCache.set(key, null); // cycle guard
    let out: FnRef | null = this.moduleFunction(file, name);
    const fromTarget = (t: ReturnType<NextAdapter['resolveName']>) =>
      t?.kind === 'def' ? this.defFunction(t.file, t.key) : t?.kind === 'value' ? this.moduleFunction(t.file, t.name) : null;
    if (!out) out = fromTarget(this.next.resolveName(file, name));
    if (!out) {
      // const { helper } = await import('@/lib/x')
      const dyn = this.dynamicImport(file, name);
      const target = dyn ? this.next.resolveModule(file, dyn.spec) : null;
      if (dyn && target) out = this.moduleFunction(target, dyn.exported) ?? fromTarget(this.next.resolveExport(target, dyn.exported));
    }
    this.helperCache.set(key, out);
    return out;
  }

  /** A name bound by `const { a, b: c } = await import('spec')` anywhere in the file. */
  private dynamicImport(file: string, local: string): { spec: string; exported: string } | null {
    let bound = this.dynamicCache.get(file);
    if (!bound) {
      bound = new Map();
      this.dynamicCache.set(file, bound);
      const root = this.tree(file);
      if (!root || !this.next.parsed.get(file)!.source.includes('import(')) return null;
      for (const d of root.descendantsOfType('variable_declarator')) {
        const v = unwrapAwait(d.childForFieldName('value'));
        if (v?.type !== 'call_expression' || v.childForFieldName('function')?.type !== 'import') continue;
        const spec = v.childForFieldName('arguments')?.namedChildren[0];
        const pattern = d.childForFieldName('name');
        if (spec?.type !== 'string' || pattern?.type !== 'object_pattern') continue;
        for (const p of pattern.namedChildren) {
          const name = p.type === 'shorthand_property_identifier_pattern' ? p.text : p.type === 'pair_pattern' ? p.childForFieldName('value')?.text : undefined;
          const exported = p.type === 'pair_pattern' ? (p.childForFieldName('key')?.text ?? name) : name;
          if (name && exported && !bound.has(name)) bound.set(name, { spec: spec.text.slice(1, -1), exported });
        }
      }
    }
    return bound.get(local) ?? null;
  }

  private importSource(file: string, local: string): string | null {
    for (const imp of this.next.infos.get(file)?.imports ?? []) if (imp.bindings.some((b) => b.local === local)) return imp.source;
    return null;
  }

  /**
   * What a call means for access: a known auth API, a project helper that reads/enforces auth, or an
   * unfollowed auth-looking helper. `delegate`: the caller returns this call's result, so any project
   * function is followed whatever its name.
   */
  private classifyCall(
    call: SyntaxNode,
    file: string,
    depth: number,
    delegate = false,
    bound = false,
    into?: FnResult,
  ): { kind: AuthVar['kind']; name: string; role: boolean; enforcing: boolean; guarded: boolean; secret: boolean; confidence: Confidence; weak?: boolean; result?: FnResult } | null {
    call = innerCall(call);
    const fn = calleeOf(call);
    if (!fn) return null;
    const text = fn.text.replace(/\s+/g, '');
    const name = calleeName(call);
    // Shown as written: `AdminApiAuthService.handleAdminAuth` rather than `handleAdminAuth`.
    const label = fn.type === 'member_expression' ? text : name;
    const plain = { enforcing: false, guarded: false, secret: false, confidence: 'medium' as Confidence };
    if (fn.type === 'member_expression' && AUTH_MEMBER.test(text)) return { ...plain, kind: 'auth', name: text, role: false };
    if (fn.type === 'identifier' && AUTH_IDS.has(name)) {
      const src = this.importSource(file, name);
      if (name !== 'auth' || (src && AUTH_PACKAGES.test(src)) || this.nextAuthBinding(file, name)) return { ...plain, kind: 'auth', name, role: false };
    }
    const authish = AUTHISH_NAME.test(name);
    if (!delegate && !authish) {
      // Any project function may enforce inside (`await updateProfile(input)` -> requireUser() throws):
      // follow it, but only a guard that throws or redirects there counts for the caller.
      if (depth >= HELPER_DEPTH) {
        if (into && this.resolveCallee(file, fn)) into.opaque = true;
        return null;
      }
      const helper = this.resolveCallee(file, fn);
      if (!helper) return null;
      const r = this.analyzeFn(helper, depth + 1);
      if (into && r.opaque) into.opaque = true;
      const role = r.guards.some((g) => g.kind === 'authorization') || r.enforcingCalls.some((c) => c.role);
      if (r.deniesByThrow && !r.softExit) return { kind: 'helper', name: label, role, enforcing: true, guarded: true, secret: false, confidence: 'medium', result: r };
      // `const bundle = await bundleFor(user); if (!bundle) throw ...`: a neutral name that reads the session.
      if (bound && r.readsAuth) return { kind: 'helper', name: label, role, enforcing: false, guarded: false, secret: false, confidence: 'medium', weak: true, result: r };
      // `if (!handle(req, res)) return`: whatever its name, it runs its own auth or secret check.
      if (r.guards.length && !r.softExit) return { kind: 'helper', name: label, role, enforcing: false, guarded: true, secret: r.checksSecret && !r.readsAuth, confidence: 'medium', result: r };
      return null;
    }
    if (depth >= HELPER_DEPTH) {
      if (into && this.resolveCallee(file, fn)) into.opaque = true;
    } else {
      const helper = this.resolveCallee(file, fn);
      if (helper) {
        const r = this.analyzeFn(helper, depth + 1);
        if (into && r.opaque) into.opaque = true;
        // `checked` entries (an auth-named call it could not read) do not make a helper about auth for its callers.
        if (r.readsAuth || r.checksSecret || r.guards.length || r.enforcingCalls.length || r.unguarded.length || r.unfollowed.some((u) => !u.checked)) {
          // A role check inside a helper only makes the caller's check a role check when the helper enforces it.
          const enforcesRole = r.deniesByThrow && !r.softExit && (r.guards.some((g) => g.kind === 'authorization') || r.enforcingCalls.some((c) => c.role));
          return {
            kind: 'helper',
            name: label,
            role: ROLE_NAME.test(name) || enforcesRole,
            enforcing: r.deniesByThrow && !r.softExit,
            guarded: r.guards.length > 0 || r.enforcingCalls.length > 0,
            secret: r.checksSecret && !r.readsAuth,
            confidence: 'medium',
            result: r,
          };
        }
        return null; // followed, and it does not touch auth
      }
    }
    if (!AUTHISH_NAME.test(name)) return null;
    return AUTH_LIKE.test(name) ? { ...plain, kind: 'like', name: label, role: ROLE_NAME.test(name), confidence: 'low' } : null;
  }

  /**
   * Does this branch stop the request? `strong`: it clearly denies (throw, redirect / notFound /
   * unauthorized / forbidden, a 401/403 or "Unauthorized" response, a failure result, or the check's own
   * failure passed on). Any other early return still keeps the code after the guard from running.
   */
  private denies(branch: SyntaxNode | null, authNames: Set<string>): { denies: boolean; byThrow: boolean; strong: boolean } {
    if (!branch || !DENY_WORDS.test(branch.text)) return { denies: false, byThrow: false, strong: false };
    let early = false;
    for (const n of this.nodesIn(branch, DENY_NODES)) {
      if (n.type === 'throw_statement') return { denies: true, byThrow: true, strong: true };
      if (n.type === 'call_expression' && n.childForFieldName('function')?.type === 'identifier' && DENY_CALLS.has(n.childForFieldName('function')!.text)) return { denies: true, byThrow: true, strong: true };
      if (n.type === 'return_statement') {
        early = true;
        const arg = n.namedChildren[0];
        if (!arg) continue;
        if (arg.type === 'identifier' && authNames.has(arg.text)) return { denies: true, byThrow: false, strong: true };
        // Passing the check's own failure on: return res(auth.status, ...), return refusal(access)
        for (const v of authNames) {
          if (new RegExp(`\\b${escapeRe(v)}\\.(status|response|error)\\b|\\w\\(\\s*${escapeRe(v)}\\s*[,)]`).test(arg.text)) return { denies: true, byThrow: false, strong: true };
        }
        if (DENY_TEXT.test(arg.text) || FAILURE_RESULT.test(arg.text)) return { denies: true, byThrow: false, strong: true };
      }
    }
    // Pages-router handlers write the denial, then return: `res.status(401).json(...); return;`
    return { denies: early, byThrow: false, strong: early && RESPONSE_DENY.test(branch.text) };
  }

  /**
   * `assertAdmin(user)`, `toSession(await auth())`: the helper throws when a parameter is missing or fails a role
   * test, and the caller passes an auth value there.
   */
  private paramEnforcement(call: SyntaxNode, file: string, depth: number, vars: Map<string, AuthVar>, into: FnResult): { name: string; role: boolean; passed: string[] } | null {
    const c = innerCall(call);
    const fn = calleeOf(c);
    const helper = fn && depth < HELPER_DEPTH ? this.resolveCallee(file, fn) : null;
    if (!helper) return null;
    const r = this.analyzeFn(helper, depth + 1);
    const args = c.childForFieldName('arguments')?.namedChildren ?? [];
    const authArg = (a: SyntaxNode | undefined) => {
      const v = unwrapAwait(a ?? null);
      if (!v) return false;
      if (v.type === 'identifier' || v.type === 'member_expression') return vars.has(v.text.split(/[.?]/)[0]);
      const cls = v.type === 'call_expression' ? this.classifyCall(v, file, depth, false, true, into) : null;
      return cls !== null && cls.kind !== 'like' && !cls.secret;
    };
    const hits = r.paramGuards.filter((g) => authArg(args[g.index]));
    const passed = hits.map((g) => unwrapAwait(args[g.index] ?? null)?.text.split(/[.?]/)[0] ?? '').filter((v) => vars.has(v));
    return hits.length ? { name: fn!.text.replace(/\s+/g, ''), role: hits.some((g) => g.role), passed } : null;
  }

  /**
   * The auth value a call is given, if any: `f(await getServerSession())`, and with `identity` (the callee's
   * name says it returns one) also an auth variable: `toSession(user)`.
   */
  private authArgument(call: SyntaxNode, file: string, depth: number, vars: Map<string, AuthVar>, into: FnResult, identity: boolean): string | null {
    for (const a of innerCall(call).childForFieldName('arguments')?.namedChildren ?? []) {
      const v = unwrapAwait(a);
      if (!v) continue;
      const root = v.text.split(/[.?]/)[0];
      if (identity && (v.type === 'identifier' || v.type === 'member_expression') && vars.has(root) && !vars.get(root)!.secret) return vars.get(root)!.via;
      const cls = v.type === 'call_expression' ? this.classifyCall(v, file, depth, false, true, into) : null;
      if (cls && cls.kind !== 'like' && !cls.secret && !cls.weak) return cls.name;
    }
    return null;
  }

  /**
   * An auth helper CodeMap could not read through that may stop the request itself: its name says it enforces
   * (`authorizeRequest`, `requireX`), or it stops on something it could not read (`if (!(await shadowAuth())) throw`).
   */
  private decidesUnread(call: SyntaxNode, file: string, depth: number): boolean {
    const c = innerCall(call);
    if (ENFORCING_PREFIX.test(calleeName(c))) return true;
    // Without a guard to go by, only names about auth itself: not `switchChatSessionForUser`, `scoreBusinessRole`.
    if (!/Auth(?!or)|^auth(?!or)/.test(calleeName(c))) return false;
    const fn = calleeOf(c);
    const helper = fn && depth < HELPER_DEPTH ? this.resolveCallee(file, fn) : null;
    return helper !== null && this.analyzeFn(helper, depth + 1).unfollowed.some((u) => u.checked);
  }

  /** Functions invoked where they are written, `(async () => {...})()`, directly in `fn` (not inside another function). */
  private iifesIn(fn: SyntaxNode, body: SyntaxNode): SyntaxNode[] {
    if (!/\)\s*\(/.test(body.text)) return [];
    return body.descendantsOfType(['arrow_function', 'function_expression', 'function']).filter((f) => {
      let call = f.parent;
      while (call?.type === 'parenthesized_expression') call = call.parent;
      if (call?.type !== 'call_expression' || !call.childForFieldName('function') || unwrapAwait(call.childForFieldName('function'))?.startIndex !== f.startIndex) return false;
      let up = f.parent;
      while (up && !FUNCTION_TYPES.has(up.type)) up = up.parent;
      return up?.startIndex === fn.startIndex && up.endIndex === fn.endIndex;
    });
  }

  /** Read to the end and found nothing about auth: the callee resolves and nothing in it was left unread. */
  private readThrough(call: SyntaxNode, file: string, depth: number): boolean {
    const fn = calleeOf(innerCall(call));
    const helper = fn && depth < HELPER_DEPTH ? this.resolveCallee(file, fn) : null;
    return helper !== null && !this.analyzeFn(helper, depth + 1).opaque;
  }

  /**
   * The secret check written as the allowed branch: `if (token === SECRET) { return ok }`, then
   * (after nothing but logging) a denying return. Webhook and cron handshakes look like this.
   */
  private allowsThenDenies(n: SyntaxNode, condNode: SyntaxNode, file: string, depth: number, authNames: Set<string>, inits: Map<string, SyntaxNode>): boolean {
    const cond = condNode.text;
    if (cond.includes('!') || n.childForFieldName('alternative')) return false;
    const secret =
      secretCompare(condNode, inits) || condNode.descendantsOfType('call_expression').some((c) => this.classifyCall(c, file, depth)?.secret);
    const cons = n.childForFieldName('consequence');
    if (!secret || !cons || !this.nodesIn(cons, RETURN_NODES).some((c) => c.type === 'return_statement')) return false;
    for (let s = n.nextNamedSibling; s; s = s.nextNamedSibling) {
      if (s.type === 'comment' || (s.type === 'expression_statement' && /^(console|logger|log)\b/.test(s.text))) continue;
      return (s.type === 'return_statement' || s.type === 'throw_statement') && this.denies(s, authNames).strong;
    }
    return false;
  }

  analyzeFn(fn: FnRef, depth = 0): FnResult {
    // Depth is part of the key: a helper read near the depth limit sees less than one read from the top.
    const key = `${fn.file}\u0000${fn.node.startIndex}\u0000${depth}`;
    const cached = this.fnCache.get(key);
    if (cached) return cached;
    // Recursion guard: a helper calling itself is read as "nothing found" while in progress.
    const result: FnResult = { guards: [], enforcingCalls: [], unguarded: [], unfollowed: [], readsAuth: false, deniesByThrow: false, checksSecret: false, opaque: false, softExit: false, paramGuards: [] };
    this.fnCache.set(key, result);
    const body = fn.node.childForFieldName('body') ?? fn.node;
    const bodyText = body.text;
    result.checksSecret = SIGNATURE_CHECK.test(bodyText);
    const vars = new Map<string, AuthVar>();
    const directCalls: { node: SyntaxNode; cls: NonNullable<ReturnType<NextSecurity['classifyCall']>> }[] = [];
    const ifs: SyntaxNode[] = [];
    /** Local `const x = ...` initializers, to tell `role = user.role` from `role = input.role`. */
    const inits = new Map<string, SyntaxNode>();
    /** Locals bound from auth-named calls CodeMap could not classify (`result = await shadowAuth(...)`). */
    const suspects = new Map<string, string>();
    // The same condition calls are read by several passes below: classify each once.
    const classified = new Map<string, ReturnType<NextSecurity['classifyCall']>>();
    const classify = (c: SyntaxNode, delegate = false, bound = false) => {
      const k = `${c.startIndex}:${c.endIndex}:${delegate}:${bound}`;
      if (!classified.has(k)) classified.set(k, this.classifyCall(c, fn.file, depth, delegate, bound, result));
      return classified.get(k)!;
    };
    const params = paramIndex(fn.node);
    // Without a secret source anywhere in the body, no condition here can compare one.
    const secretsHere = SECRET_COND.test(bodyText);
    /** Auth variables handed to a helper that throws without them: `assertAdmin(user)` guards `user`. */
    const passedToEnforcer = new Set<string>();

    for (const n of this.nodesIn(body, BODY_NODES)) {
      if (n.type === 'variable_declarator' || n.type === 'assignment_expression') {
        // `x = await f()`, also `x = cond ? given : await f()` and `x = a ?? await f()`.
        const value = n.childForFieldName(n.type === 'variable_declarator' ? 'value' : 'right');
        if (n.type === 'variable_declarator' && value) for (const name of boundNames(n.childForFieldName('name'))) inits.set(name, value);
        for (const call of returnedCalls(value)) {
          const cls = classify(call, false, true);
          if (!cls) {
            // `const session = toSession(await auth())`: a helper that throws without the auth value it is given.
            const pe = this.paramEnforcement(call, fn.file, depth, vars, result);
            if (pe) {
              result.enforcingCalls.push({ name: pe.name, role: pe.role, file: fn.file, line: n.startPosition.row + 1, confidence: 'medium' });
              for (const v of pe.passed) passedToEnforcer.add(v);
              result.readsAuth = true;
              for (const name of boundNames(n.childForFieldName(n.type === 'variable_declarator' ? 'name' : 'left'))) vars.set(name, { via: pe.name, kind: 'helper', role: pe.role, line: n.startPosition.row + 1, file: fn.file, weak: true });
              continue;
            }
            // `const session = toExportSession(await getServerAuthSession(ctx))`: an identity made from an auth value
            // (not `limit = rateLimit(user.id)`, which only uses it). An auth call passed straight in is wrapped,
            // whatever the wrapper is called: `withTimeout(auth())`.
            const from = this.authArgument(call, fn.file, depth, vars, result, IDENTITY_NAME.test(calleeName(innerCall(call))));
            if (from) {
              result.readsAuth = true;
              for (const name of boundNames(n.childForFieldName(n.type === 'variable_declarator' ? 'name' : 'left'))) vars.set(name, { via: from, kind: 'helper', role: false, line: n.startPosition.row + 1, file: fn.file });
              continue;
            }
            const auth = strongAuthCall(call);
            if (auth && !this.readThrough(call, fn.file, depth)) {
              result.opaque = true;
              // `const scope = await authorizeRequest(req)`: it may throw, on grounds CodeMap could not read.
              if (this.decidesUnread(call, fn.file, depth)) result.unfollowed.push({ name: auth, file: fn.file, line: n.startPosition.row + 1, checked: true });
            }
            if (auth && !this.readThrough(call, fn.file, depth)) for (const name of boundNames(n.childForFieldName(n.type === 'variable_declarator' ? 'name' : 'left'))) suspects.set(name, auth);
            continue;
          }
          const names = boundNames(n.childForFieldName(n.type === 'variable_declarator' ? 'name' : 'left'));
          const rolePass = cls.result?.guards.some((g) => g.kind === 'authorization' && g.strong) ?? false;
          for (const name of names) {
            vars.set(name, { via: cls.name, kind: cls.kind, role: cls.role, line: n.startPosition.row + 1, file: fn.file, ...(cls.weak ? { weak: true } : {}), ...(cls.secret ? { secret: true } : {}), ...(rolePass ? { rolePass } : {}) });
          }
          if (cls.enforcing) result.enforcingCalls.push({ name: cls.name, role: cls.role, file: fn.file, line: n.startPosition.row + 1, confidence: cls.confidence });
          result.readsAuth ||= cls.kind !== 'like' && !cls.secret;
        }
      } else if (n.type === 'expression_statement' || n.type === 'return_statement' || (n.id === body.id && body.type !== 'statement_block')) {
        // `return handle(req)` / `return withUser(req, async () => ...)` / `return a ? f() : g()`: the response
        // is that function's, so follow it. Expression-bodied arrows return their body.
        const returned = n.type !== 'expression_statement';
        const expr = n.type === 'expression_statement' || n.type === 'return_statement' ? (n.namedChildren[0] ?? null) : n;
        for (const call of returned ? returnedCalls(expr) : [unwrapAwait(expr)].filter((c): c is SyntaxNode => c?.type === 'call_expression')) {
          const cls = classify(call, returned);
          if (!cls) {
            // `assertAdmin(user)`: throws when the user it is given is missing or not an admin.
            const pe = this.paramEnforcement(call, fn.file, depth, vars, result);
            if (pe) {
              result.enforcingCalls.push({ name: pe.name, role: pe.role, file: fn.file, line: n.startPosition.row + 1, confidence: 'medium' });
              for (const v of pe.passed) passedToEnforcer.add(v);
              continue;
            }
            // `await verifyApiKey(req)` that CodeMap could not read through: it may throw.
            const auth = strongAuthCall(call);
            if (auth && !this.readThrough(call, fn.file, depth)) {
              result.opaque = true;
              if (this.decidesUnread(call, fn.file, depth)) result.unfollowed.push({ name: auth, file: fn.file, line: n.startPosition.row + 1, checked: true });
            }
            continue;
          }
          result.readsAuth ||= cls.kind !== 'like' && !cls.secret;
          const line = n.startPosition.row + 1;
          if (cls.enforcing || (returned && cls.guarded)) result.enforcingCalls.push({ name: cls.name, role: cls.role, file: fn.file, line, confidence: cls.confidence });
          else if (cls.kind === 'like') result.unfollowed.push({ name: cls.name, file: fn.file, line });
          if (returned && cls.secret) result.checksSecret = true;
          if (returned && cls.result) {
            // What the delegate leaves unresolved stays unresolved here.
            result.unguarded.push(...cls.result.unguarded);
            result.unfollowed.push(...cls.result.unfollowed);
          }
        }
      } else if (n.type === 'if_statement') {
        ifs.push(n);
      } else if (n.type === 'try_statement') {
        // try { event = stripe.webhooks.constructEvent(body, sig, secret) } catch { return 400 }
        const block = n.childForFieldName('body');
        const handler = n.childForFieldName('handler');
        const sig = block ? SIGNATURE_CHECK.exec(block.text) : null;
        const d = sig && handler ? this.denies(handler.childForFieldName('body'), new Set()) : null;
        if (sig && d?.denies) {
          result.guards.push({ kind: 'authentication', secret: true, text: `try { …${sig[0].replace(/\($/, '')}(…) } catch`, file: fn.file, line: n.startPosition.row + 1, ifNode: n, strong: d.strong, confidence: d.strong ? 'medium' : 'low', via: '' });
        }
      }
    }
    // `(async () => { const session = await auth(); ... })()` runs inline: what it reads without guarding, or
    // could not read, belongs to this function too. Its guards do not: a return there only leaves the IIFE.
    for (const iife of this.iifesIn(fn.node, body)) {
      const r = this.analyzeFn({ node: iife, file: fn.file }, depth);
      result.unguarded.push(...r.unguarded);
      result.unfollowed.push(...r.unfollowed);
      result.readsAuth ||= r.readsAuth;
      result.opaque ||= r.opaque;
    }
    // Inside helpers, any auth API call counts as reading auth (`return supabase.auth.getUser()`).
    if (depth > 0 && !result.readsAuth && AUTH_MEMBER_WORDS.test(bodyText)) {
      for (const n of this.nodesIn(body, CALL_NODES)) {
        const fnNode = n.childForFieldName('function');
        if (fnNode?.type === 'member_expression' && AUTH_MEMBER.test(fnNode.text.replace(/\s+/g, ''))) {
          result.readsAuth = true;
          break;
        }
      }
    }

    // Flags set from a check: `let ok = Boolean(secret && token === secret)`, `ok = Boolean(user && isAdmin(user))`,
    // `const isOwner = listing.ownerId === user.id`.
    for (const n of this.nodesIn(body, BODY_NODES)) {
      if (n.type !== 'variable_declarator' && n.type !== 'assignment_expression') continue;
      const left = n.childForFieldName(n.type === 'variable_declarator' ? 'name' : 'left');
      const value = unwrapAwait(n.childForFieldName(n.type === 'variable_declarator' ? 'value' : 'right'));
      if (left?.type !== 'identifier' || !value || !booleanExpr(value)) continue;
      const text = value.text;
      const authRefs = [...vars.keys()].filter((v) => v !== left.text && wordRe(v).test(text));
      const existing = vars.get(left.text);
      if (existing) {
        if (existing.from) existing.from.push(...authRefs);
        continue;
      }
      const secretOnly = !authRefs.length && secretsHere && secretCompare(value, inits);
      if (!authRefs.length && !secretOnly) continue;
      const role = ROLE_COND.test(text) || authRefs.some((v) => vars.get(v)!.role);
      vars.set(left.text, { via: secretOnly ? 'secret check' : 'session check', kind: 'helper', role, line: n.startPosition.row + 1, file: fn.file, weak: true, from: authRefs, ...(secretOnly ? { secret: true } : {}) });
    }

    // Flag variables: `if (secretOk || (user && isAdmin(user))) isAuthorized = true` ... `if (!isAuthorized) return 401`.
    for (const n of ifs) {
      const condNode = n.childForFieldName('condition');
      const cons = n.childForFieldName('consequence');
      if (!condNode || !cons) continue;
      const cond = condNode.text;
      const authRefs = [...vars.keys()].filter((v) => wordRe(v).test(cond));
      const condCalls = condNode.descendantsOfType('call_expression').map((c) => classify(c)).filter((c) => c !== null);
      const secretCond = (secretsHere && secretCompare(condNode, inits)) || condCalls.some((c) => c!.secret);
      if (!authRefs.length && !condCalls.length && !secretCond) continue;
      for (const a of cons.descendantsOfType('assignment_expression')) {
        const left = a.childForFieldName('left');
        if (left?.type !== 'identifier' || a.childForFieldName('right')?.text !== 'true' || vars.has(left.text)) continue;
        const role = ROLE_COND.test(cond) || authRefs.some((v) => vars.get(v)!.role) || condCalls.some((c) => c!.role);
        const secretOnly = secretCond && !authRefs.length && !condCalls.some((c) => !c!.secret);
        vars.set(left.text, { via: secretOnly ? 'secret check' : 'session check', kind: 'helper', role, line: a.startPosition.row + 1, file: fn.file, weak: true, from: authRefs, ...(secretOnly ? { secret: true } : {}) });
      }
    }

    // A shared secret compared with something from the request (not `if (!env.KEY)` or `env.KEY === undefined`).
    if (!result.checksSecret && SECRET_COND.test(bodyText)) result.checksSecret = this.nodesIn(body, COMPARE_NODES).some((b) => secretComparison(b, inits));
    const authNames = new Set(vars.keys());
    const usedInGuard = new Set<string>();
    for (const n of ifs) {
      const condNode = n.childForFieldName('condition');
      if (!condNode) continue;
      const cond = condNode.text;
      const d = this.denies(n.childForFieldName('consequence'), authNames);
      if (!d.strong && this.allowsThenDenies(n, condNode, fn.file, depth, authNames, inits)) {
        result.guards.push({ kind: 'authentication', secret: true, text: guardText(condNode), file: fn.file, line: n.startPosition.row + 1, ifNode: n, strong: true, confidence: 'medium', via: '' });
        continue;
      }
      if (!d.denies) continue;
      // Auth calls written inside the condition: if (!(await isAdmin())) ...
      for (const c of condNode.descendantsOfType('call_expression')) {
        const cls = classify(c);
        if (cls) {
          directCalls.push({ node: c, cls });
          result.readsAuth ||= cls.kind !== 'like' && !cls.secret;
        }
      }
      const refs = [...authNames].filter((v) => wordRe(v).test(cond));
      // `if (guard.error) return guard.error`: the helper's own failure, passed on, counts like a missing user.
      const failed = refs.filter((v) => !absenceOf(cond, v) && failureOf(cond, v) && d.strong);
      const absent = [...refs.filter((v) => absenceOf(cond, v)), ...failed];
      const inline = directCalls.filter((c) => c.node.startIndex >= condNode.startIndex && c.node.endIndex <= condNode.endIndex);
      const inlineAbsent = inline.length > 0 && /!/.test(cond);
      const roleText = withoutErrors(cond);
      const role =
        (ROLE_COND.test(roleText) && ROLE_NEGATIVE.test(roleText) && roleTied(condNode, authNames, inits)) ||
        absent.some((v) => vars.get(v)!.role) ||
        failed.some((v) => vars.get(v)!.rolePass) ||
        (inlineAbsent && inline.some((c) => c.cls.role));
      // Denying when the secret matches makes no sense: the test must be the failed one (`!==`, `!verify(...)`).
      const secret = /!/.test(cond) && ((secretsHere && secretCompare(condNode, inits)) || inline.some((c) => c.cls.secret));
      const hasAuthContext = authNames.size > 0 || inline.length > 0 || result.enforcingCalls.length > 0;
      if (d.byThrow) {
        // Throws on a parameter: the caller decides what it passes in (see paramEnforcement).
        for (const [p, index] of params) {
          if (authNames.has(p) || !wordRe(p).test(cond)) continue;
          const paramRole = ROLE_COND.test(roleText) && ROLE_NEGATIVE.test(roleText);
          if (absenceOf(cond, p) || paramRole) result.paramGuards.push({ index, role: paramRole });
        }
      }
      if (!(absent.length || inlineAbsent || secret || (role && hasAuthContext))) {
        // The request stops on the result of an auth-named function CodeMap could not read: unknown, never "no protection".
        const suspect = [...suspects.keys()].find((v) => wordRe(v).test(cond));
        const inlineSuspect = suspect
          ? null
          : condNode
              .descendantsOfType('call_expression')
              .filter((c) => !classify(c) && !this.readThrough(c, fn.file, depth))
              .map(strongAuthCall)
              .find((x) => x);
        const name = suspect ? suspects.get(suspect)! : inlineSuspect;
        if (name) result.unfollowed.push({ name, file: fn.file, line: n.startPosition.row + 1, checked: true });
        continue;
      }
      for (const v of refs) for (const used of [v, ...(vars.get(v)!.from ?? [])]) usedInGuard.add(used);
      const sources = [...absent.map((v) => vars.get(v)!), ...inline.map((c) => ({ kind: c.cls.kind, via: c.cls.name }))];
      const weakest: Confidence = sources.some((s) => s.kind === 'like') ? 'low' : 'medium';
      result.guards.push({
        kind: role ? 'authorization' : 'authentication',
        secret: (secret && !absent.length && inline.every((c) => c.cls.secret)) || (absent.length > 0 && absent.every((v) => vars.get(v)!.secret) && inline.every((c) => c.cls.secret)),
        text: guardText(condNode),
        file: fn.file,
        line: n.startPosition.row + 1,
        ifNode: n,
        strong: d.strong,
        confidence: !d.strong ? 'low' : secret && !sources.length ? 'medium' : weakest,
        via: sources.map((s) => `${s.via}()`).join(', '),
      });
      result.deniesByThrow ||= d.byThrow;
    }
    for (const [name, v] of vars) {
      if (!v.weak && !usedInGuard.has(name) && !passedToEnforcer.has(name) && !(v.kind === 'helper' && result.enforcingCalls.some((c) => c.name === v.via))) result.unguarded.push(v);
    }
    // A function whose own guard is a secret check is a secret check for its callers too.
    result.checksSecret ||= result.guards.some((g) => g.secret);
    // A helper that guards and throws/redirects itself: calling it is enough.
    result.deniesByThrow ||= result.enforcingCalls.length > 0 && depth > 0;
    // ...unless it can return nothing before any check throws: verifyGatewayToken() that returns null without a
    // token denies nobody. Early returns after the check (`if (isAdmin) return`) only let people through.
    let firstThrow = Math.min(Infinity, ...result.enforcingCalls.filter((c) => c.file === fn.file).map((c) => c.line - 1));
    const softRows: number[] = [];
    for (const n of ifs) {
      const cons = n.childForFieldName('consequence');
      if (!cons) continue;
      if (this.denies(cons, authNames).byThrow) firstThrow = Math.min(firstThrow, n.startPosition.row);
      else if (this.nodesIn(cons, RETURN_NODES).some((r) => r.type === 'return_statement' && /^(null|undefined|false)?$/.test(r.namedChildren[0]?.text ?? ''))) softRows.push(n.startPosition.row);
    }
    result.softExit = softRows.some((row) => row < firstThrow);
    return result;
  }
}

/**
 * Is a role test about the signed-in user? The condition must read an auth variable, call a
 * permission-named function that takes no arguments (`isAdmin()` reads the session itself), or reach one
 * of those through local variables (`role = profile.data.role; profile = ...eq('id', user.id)`). A `role`
 * taken from form input, or `isAdminCategoryId(categoryId)`, is validation, not authorization.
 */
function roleTied(cond: SyntaxNode, authNames: Set<string>, inits: Map<string, SyntaxNode>): boolean {
  const authRe = authNames.size ? new RegExp(`\\b(${[...authNames].map(escapeRe).join('|')})\\b`) : null;
  const seen = new Set<string>();
  const reads = (n: SyntaxNode, hops: number): boolean => {
    if (authRe?.test(n.text)) return true;
    for (const c of n.descendantsOfType('call_expression')) {
      if (PERMISSION_FN.test(calleeName(c)) && !c.childForFieldName('arguments')?.namedChildCount) return true;
    }
    if (hops === 0) return false;
    for (const id of n.descendantsOfType(['identifier', 'shorthand_property_identifier'])) {
      const init = inits.get(id.text);
      if (!init || seen.has(id.text)) continue;
      seen.add(id.text);
      if (reads(init, hops - 1)) return true;
    }
    return false;
  };
  return reads(cond, 3);
}

/**
 * Does the condition compare a secret with a value: `token === process.env.CRON_SECRET`, or through locals
 * (`expected = process.env.VERIFY_TOKEN || ...; if (token === expected)`)? Comparing with null, undefined, a
 * boolean, a number or an empty string only tests whether the secret is configured.
 */
function secretCompare(cond: SyntaxNode, inits: Map<string, SyntaxNode>): boolean {
  if (!/===|!==|==|!=/.test(cond.text)) return false;
  return [cond, ...cond.descendantsOfType('binary_expression')].some((b) => secretComparison(b, inits));
}

const NON_VALUE = /^(null|undefined|true|false|\d+|''|""|``)$/;

function secretComparison(b: SyntaxNode, inits: Map<string, SyntaxNode>): boolean {
  if (b.type !== 'binary_expression' || !/^(===|!==|==|!=)$/.test(b.childForFieldName('operator')?.text ?? '')) return false;
  const left = b.childForFieldName('left');
  const right = b.childForFieldName('right');
  if (!left || !right) return false;
  const secret = (x: SyntaxNode) => SECRET_COND.test(withSecretLocals(x, inits));
  return (secret(left) && !NON_VALUE.test(right.text.trim())) || (secret(right) && !NON_VALUE.test(left.text.trim()));
}

/** The expression's text plus the initializers of the secret-valued locals it uses (two steps). */
function withSecretLocals(x: SyntaxNode, inits: Map<string, SyntaxNode>): string {
  let text = x.text;
  let frontier = [x, ...x.descendantsOfType('identifier')].filter((n) => n.type === 'identifier').map((id) => id.text);
  const seen = new Set<string>();
  for (let hop = 0; hop < 2 && frontier.length; hop++) {
    const next: string[] = [];
    for (const name of frontier) {
      const init = inits.get(name);
      // Only locals that hold the secret itself; `res = await fetch(url, { headers: { key: process.env.KEY } })` does not.
      if (!init || seen.has(name) || !secretValue(init)) continue;
      seen.add(name);
      text += `\n${init.text}`;
      next.push(...init.descendantsOfType('identifier').map((id) => id.text));
    }
    frontier = next;
  }
  return text;
}

/** Calls that only reshape a value: `process.env.X?.trim()`, `headers.get('authorization')?.replace('Bearer ', '')`. */
const VALUE_CALLS = new Set(['get', 'trim', 'replace', 'slice', 'substring', 'toString', 'split', 'at', 'toLowerCase', 'String']);

function secretValue(init: SyntaxNode): boolean {
  if (init.descendantsOfType('await_expression').length || init.descendantsOfType(['arrow_function', 'function_expression']).length) return false;
  return init.descendantsOfType('call_expression').every((c) => VALUE_CALLS.has(calleeName(c)));
}

/** `if (cond)` on one line: conditions often span several (`if (\n  !Auth.check(req, res)\n)`). */
function guardText(cond: SyntaxNode): string {
  const t = cond.text.replace(/\s+/g, ' ').replace(/^\(\s*|\s*\)$/g, '');
  return `if (${t.length > 70 ? t.slice(0, 69) + '…' : t})`;
}

/** Parameter names by position, including destructured ones: `(req, { user })` -> req 0, user 1. */
function paramIndex(fn: SyntaxNode): Map<string, number> {
  const out = new Map<string, number>();
  const single = fn.childForFieldName('parameter');
  const list = fn.childForFieldName('parameters')?.namedChildren ?? (single ? [single] : []);
  list.forEach((p, i) => {
    const pattern = p.childForFieldName('pattern') ?? (p.type === 'assignment_pattern' ? p.childForFieldName('left') : p);
    for (const name of boundNames(pattern)) out.set(name, i);
  });
  return out;
}

/**
 * A value that is a yes/no answer: `Boolean(...)`, `!x`, `a === b`, `isAdmin(u)`, or `&&` / `||` of those.
 * `email || user.email` is a fallback value, not a check.
 */
function booleanExpr(v: SyntaxNode): boolean {
  if (v.type === 'parenthesized_expression') return v.namedChildren[0] ? booleanExpr(v.namedChildren[0]) : false;
  if (v.type === 'unary_expression') return v.childForFieldName('operator')?.text === '!';
  if (v.type === 'call_expression') return calleeOf(v)?.text === 'Boolean' || /^(is|has|can)[A-Z]/.test(calleeName(v));
  if (v.type !== 'binary_expression') return false;
  const op = v.childForFieldName('operator')?.text ?? '';
  if (/^(===|!==|==|!=)$/.test(op)) return true;
  const [l, r] = [v.childForFieldName('left'), v.childForFieldName('right')];
  return (op === '&&' || op === '||') && !!l && !!r && booleanExpr(l) && booleanExpr(r);
}

/** The condition with error values blanked: `!roleError.message.includes(...)` is error handling, not a role test. */
const withoutErrors = (cond: string) => cond.replace(/\b\w*(Error|Err|error|err)\b(\??\.\w+|\([^()]*\))*/g, 'ERR');

// ---------------------------------------------------------------------------------------------
// middleware.ts / proxy.ts

export interface MiddlewareReport {
  file: string;
  /** null: no matcher (runs on every path); 'unknown': a matcher CodeMap could not read. */
  matcher: string[] | null | 'unknown';
  /** Matcher entries with `has` / `missing` conditions: a request shaped by the client can skip them. */
  conditional: string[];
  /** Other middleware / proxy files, which Next.js does not read. */
  ignored: string[];
  gates: { kind: Guard['kind']; text: string; file: string; line: number; paths: string; evaluated: boolean }[];
}

type Tri = 'yes' | 'no' | 'unknown' | 'na';
/** Does middleware run for a path: 'conditional' when only a `has` / `missing` matcher entry covers it. */
type Coverage = 'yes' | 'no' | 'unknown' | 'conditional';

/** Path-to-regexp (the Next.js matcher syntax) to a RegExp, for the common forms. */
export function matcherRegex(pattern: string): RegExp | null {
  let out = '';
  for (let i = 0; i < pattern.length; ) {
    const rest = pattern.slice(i);
    const param = /^\/?:([A-Za-z_]\w*)(\([^)]*\))?([*+?])?/.exec(rest);
    if (param) {
      const slash = rest.startsWith('/') ? '/' : '';
      const body = param[2] ? param[2].slice(1, -1) : '[^/]+';
      const mod = param[3];
      out += mod === '*' ? `(?:${slash}${body}(?:/${body})*)?` : mod === '+' ? `${slash}${body}(?:/${body})*` : mod === '?' ? `(?:${slash}${body})?` : `${slash}${body}`;
      i += param[0].length;
      continue;
    }
    if (pattern[i] === '(') {
      // A raw regex group: copy up to the matching parenthesis.
      let depth = 0;
      let j = i;
      for (; j < pattern.length; j++) {
        if (pattern[j] === '\\') {
          j++;
          continue;
        }
        if (pattern[j] === '(') depth++;
        else if (pattern[j] === ')' && --depth === 0) break;
      }
      if (j >= pattern.length) return null;
      out += pattern.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += escapeRe(pattern[i]);
    i++;
  }
  try {
    return new RegExp(`^${out}/?$`);
  } catch {
    return null;
  }
}

export class MiddlewareGates {
  readonly report: MiddlewareReport;
  private regexes: { re: RegExp; conditional: boolean }[] | null | 'unknown';
  private gates: { guard: Guard; conds: { node: SyntaxNode; negate: boolean }[] }[] = [];

  constructor(
    private sec: NextSecurity,
    private next: NextAdapter,
    file: string,
    ignored: string[] = [],
  ) {
    const root = next.parsed.get(file)!.tree.rootNode;
    const { matcher, entries } = readMatcher(root);
    if (matcher === null || matcher === 'unknown') this.regexes = matcher;
    else {
      const res = entries.map((e) => ({ re: matcherRegex(e.source), conditional: e.condition !== null }));
      this.regexes = res.every((r) => r.re !== null) ? (res as { re: RegExp; conditional: boolean }[]) : 'unknown';
    }
    const conditional = entries.filter((e) => e.condition).map((e) => `${e.source} (skipped when ${e.condition})`);
    this.report = { file, matcher, conditional, ignored, gates: [] };
    const fn = middlewareFunction(root);
    if (!fn) return;
    const fns: FnRef[] = [{ node: fn, file }];
    // Gates often live in a helper the middleware returns or awaits (Supabase's updateSession(request)).
    for (const n of scope(fn.childForFieldName('body') ?? fn, CALL_NODES)) {
      if (n.type !== 'call_expression' || n.childForFieldName('function')?.type !== 'identifier') continue;
      if (!/request|req\b/.test(n.childForFieldName('arguments')?.text ?? '')) continue;
      const helper = sec.resolveHelper(file, n.childForFieldName('function')!.text);
      if (helper) fns.push(helper);
    }
    for (const f of fns) {
      for (const guard of sec.analyzeFn(f).guards) {
        const conds = enclosingConds(guard.ifNode, f.node);
        this.gates.push({ guard, conds });
        const paths = this.describe(conds, f);
        this.report.gates.push({ kind: guard.kind, text: guard.text, file: guard.file, line: guard.line, paths: paths.text, evaluated: paths.evaluated });
      }
    }
  }

  /** Does middleware run for this path? */
  covers(path: string): Coverage {
    if (this.regexes === null) return 'yes';
    if (this.regexes === 'unknown') return 'unknown';
    const hits = this.regexes.filter((r) => r.re.test(path));
    return hits.some((r) => !r.conditional) ? 'yes' : hits.length ? 'conditional' : 'no';
  }

  /** Gates that apply to a concrete path ('yes'), may apply ('unknown'). */
  gatesFor(path: string): { applies: Guard[]; unevaluated: Guard[] } {
    const applies: Guard[] = [];
    const unevaluated: Guard[] = [];
    for (const g of this.gates) {
      let v: Tri = 'na';
      for (const c of g.conds) {
        let r = evalPath(c.node, path, g.guard.file, this.next);
        if (c.negate) r = r === 'yes' ? 'no' : r === 'no' ? 'yes' : r;
        if (r === 'no') {
          v = 'no';
          break;
        }
        if (r === 'unknown') v = 'unknown';
        else if (r === 'yes' && v === 'na') v = 'yes';
      }
      if (v === 'yes' || v === 'na') applies.push(g.guard);
      else if (v === 'unknown') unevaluated.push(g.guard);
    }
    return { applies, unevaluated };
  }

  private describe(conds: { node: SyntaxNode; negate: boolean }[], f: FnRef): { text: string; evaluated: boolean } {
    const probes = ['/api/x', '/dashboard', '/admin', '/'];
    const tests = conds.map((c) => ({ c, r: probes.map((p) => evalPath(c.node, p, f.file, this.next)) }));
    if (tests.some((t) => t.r.includes('unknown'))) return { text: 'path condition not evaluated', evaluated: false };
    const pathTests = tests.filter((t) => t.r.some((x) => x !== 'na'));
    return { text: pathTests.length ? pathTests.map((t) => `${t.c.negate ? 'not ' : ''}${firstLine(t.c.node, 60)}`).join(' and ') : 'every path it runs on', evaluated: true };
  }
}

type MatcherEntry = { source: string; condition: string | null };

/**
 * `export const config = { matcher }`: strings, or objects `{ source, has, missing }`. `condition` describes
 * when an entry with `has` / `missing` lets a request through without running the middleware.
 */
function readMatcher(root: SyntaxNode): { matcher: string[] | null | 'unknown'; entries: MatcherEntry[] } {
  const none = { matcher: null, entries: [] };
  const unknown = { matcher: 'unknown' as const, entries: [] };
  const literal = (s: SyntaxNode | null | undefined) =>
    s && (s.type === 'string' || (s.type === 'template_string' && !s.namedChildren.some((c) => c.type === 'template_substitution'))) ? s.text.slice(1, -1) : null;
  const field = (obj: SyntaxNode, key: string) => obj.namedChildren.find((p) => p.type === 'pair' && p.childForFieldName('key')?.text.replace(/['"]/g, '') === key)?.childForFieldName('value') ?? null;
  for (const top of root.namedChildren) {
    if (top.type !== 'export_statement') continue;
    const decl = top.childForFieldName('declaration') ?? top.namedChildren[0];
    for (const d of decl?.namedChildren ?? []) {
      if (d.type !== 'variable_declarator' || d.childForFieldName('name')?.text !== 'config') continue;
      const obj = d.childForFieldName('value');
      const v = obj ? field(obj, 'matcher') : null;
      if (!v) return none;
      const entries: MatcherEntry[] = [];
      for (const s of v.type === 'array' ? v.namedChildren : [v]) {
        if (s.type === 'comment') continue;
        const plain = literal(s);
        if (plain !== null) {
          entries.push({ source: plain, condition: null });
          continue;
        }
        const source = s.type === 'object' ? literal(field(s, 'source')) : null;
        if (source === null) return unknown;
        // missing: [{ type: 'header', key: 'next-router-prefetch' }] -> skipped when the request has that header.
        const describe = (list: SyntaxNode | null, present: boolean) =>
          (list?.namedChildren ?? [])
            .filter((c) => c.type === 'object')
            .map((c) => `${present ? 'the request has' : 'the request lacks'} ${literal(field(c, 'type')) ?? '?'} ${literal(field(c, 'key')) ?? '?'}${literal(field(c, 'value')) ? `=${literal(field(c, 'value'))}` : ''}`);
        const when = [...describe(field(s, 'missing'), true), ...describe(field(s, 'has'), false)];
        entries.push({ source, condition: when.length ? when.join(' or ') : null });
      }
      return { matcher: entries.map((e) => e.source), entries };
    }
  }
  return none;
}

function middlewareFunction(root: SyntaxNode): SyntaxNode | null {
  for (const top of root.namedChildren) {
    if (top.type !== 'export_statement') continue;
    const decl = top.childForFieldName('declaration') ?? top.namedChildren[0];
    if (!decl) continue;
    const isDefault = top.children.some((c) => c.type === 'default');
    if (decl.type === 'function_declaration' && (isDefault || /^(middleware|proxy)$/.test(decl.childForFieldName('name')?.text ?? ''))) return decl;
    if (isDefault && FUNCTION_TYPES.has(decl.type)) return decl;
    if (decl.type === 'lexical_declaration') {
      for (const d of decl.namedChildren) {
        if (d.type === 'variable_declarator' && /^(middleware|proxy)$/.test(d.childForFieldName('name')?.text ?? '')) {
          const v = d.childForFieldName('value');
          if (v && FUNCTION_TYPES.has(v.type)) return v;
        }
      }
    }
  }
  return null;
}

/** Conditions on the way to a guard: its own and those of the ifs it sits in (negated in else branches). */
function enclosingConds(ifNode: SyntaxNode, fn: SyntaxNode): { node: SyntaxNode; negate: boolean }[] {
  const out: { node: SyntaxNode; negate: boolean }[] = [];
  const own = ifNode.childForFieldName('condition');
  if (own) out.push({ node: own, negate: false });
  let child = ifNode;
  for (let p = ifNode.parent; p && p.id !== fn.id; child = p, p = p.parent) {
    if (p.type === 'if_statement') {
      const cond = p.childForFieldName('condition');
      const inElse = p.childForFieldName('alternative')?.id === child.id;
      if (cond && cond.id !== child.id) out.push({ node: cond, negate: inElse });
    }
  }
  return out;
}

const PATHNAME = /^(pathname|(req|request)\.nextUrl\.pathname|(req|request)\.url\.pathname|nextUrl\.pathname|url\.pathname)$/;

interface EvalCtx {
  path: string;
  file: string;
  next: NextAdapter;
  depth: number;
  /** Identifiers that hold the request path (helper parameters). */
  pathIds: Set<string>;
  /** String values bound to identifiers (the item of a `.some(p => ...)` callback). */
  env: Map<string, string>;
}

const isPathRef = (n: SyntaxNode, ctx: EvalCtx) => PATHNAME.test(n.text.replace(/\s+/g, '')) || ctx.pathIds.has(n.text);

/** Evaluate the path-dependent part of a condition for a concrete path. Non-path parts are 'na'. */
function evalPath(node: SyntaxNode, path: string, file: string, next: NextAdapter): Tri {
  return evalIn(node, { path, file, next, depth: 0, pathIds: new Set(), env: new Map() });
}

function evalIn(node: SyntaxNode, ctx: EvalCtx): Tri {
  if (ctx.depth > 8) return 'unknown';
  const sub = (x: SyntaxNode, more: Partial<EvalCtx> = {}) => evalIn(x, { ...ctx, depth: ctx.depth + 1, ...more });
  const n = node.type === 'parenthesized_expression' ? node.namedChildren[0] : node;
  if (!n) return 'na';
  if (n.type === 'unary_expression' && n.children[0]?.text === '!') {
    const r = sub(n.namedChildren[0]);
    return r === 'yes' ? 'no' : r === 'no' ? 'yes' : r;
  }
  if (n.type === 'binary_expression') {
    const op = n.childForFieldName('operator')?.text ?? n.children.find((c) => !c.isNamed)?.text;
    const l = n.childForFieldName('left')!;
    const r = n.childForFieldName('right')!;
    if (op === '&&' || op === '||') {
      const a = sub(l);
      const b = sub(r);
      if (op === '&&') {
        if (a === 'no' || b === 'no') return 'no';
        if (a === 'unknown' || b === 'unknown') return 'unknown';
        return a === 'yes' || b === 'yes' ? 'yes' : 'na';
      }
      if (a === 'yes' || b === 'yes') return 'yes';
      if (a === 'unknown' || b === 'unknown') return 'unknown';
      // A path test OR'ed with something else (e.g. a user check) cannot be decided from the path.
      if (a === 'na' || b === 'na') return a === 'no' || b === 'no' ? 'unknown' : 'na';
      return 'no';
    }
    if (op === '===' || op === '==' || op === '!==' || op === '!=') {
      const pathSide = isPathRef(l, ctx) ? l : isPathRef(r, ctx) ? r : null;
      if (pathSide) {
        const s = stringValue(pathSide === l ? r : l, ctx);
        if (s === null) return 'unknown';
        const eq = s === ctx.path;
        return (op.startsWith('!') ? !eq : eq) ? 'yes' : 'no';
      }
      return mentionsPath(n, ctx) ? 'unknown' : 'na';
    }
    return mentionsPath(n, ctx) ? 'unknown' : 'na';
  }
  if (n.type === 'call_expression') {
    const fn = n.childForFieldName('function');
    const args = n.childForFieldName('arguments')?.namedChildren ?? [];
    if (fn?.type === 'member_expression') {
      const obj = fn.childForFieldName('object')!;
      const prop = fn.childForFieldName('property')?.text;
      if (isPathRef(obj, ctx) && (prop === 'startsWith' || prop === 'endsWith' || prop === 'includes') && args[0]) {
        const s = stringValue(args[0], ctx);
        if (s === null) return 'unknown';
        return (prop === 'startsWith' ? ctx.path.startsWith(s) : prop === 'endsWith' ? ctx.path.endsWith(s) : ctx.path.includes(s)) ? 'yes' : 'no';
      }
      // PREFIXES.some((p) => pathname.startsWith(p)), PATHS.includes(pathname)
      const list = constStrings(obj, ctx.file, ctx.next);
      if (list && prop === 'includes' && args[0] && isPathRef(args[0], ctx)) return list.includes(ctx.path) ? 'yes' : 'no';
      if (list && prop === 'some' && args[0] && (args[0].type === 'arrow_function' || args[0].type === 'function_expression')) {
        const param = args[0].childForFieldName('parameter')?.text ?? args[0].childForFieldName('parameters')?.namedChildren[0]?.text;
        const body = callbackExpr(args[0]);
        if (!param || !body) return 'unknown';
        let out: Tri = 'no';
        for (const item of list) {
          const r = sub(body, { env: new Map([...ctx.env, [param, item]]) });
          if (r === 'yes') return 'yes';
          if (r !== 'no') out = 'unknown';
        }
        return out;
      }
      return mentionsPath(n, ctx) ? 'unknown' : 'na';
    }
    // isProtected(pathname): a same-file helper whose body is a single returned expression.
    const pIndex = args.findIndex((a) => isPathRef(a, ctx));
    if (fn?.type === 'identifier' && pIndex >= 0) {
      const helper = singleReturn(ctx.file, fn.text, ctx.next);
      if (!helper || !helper.params[pIndex]) return 'unknown';
      return sub(helper.expr, { pathIds: new Set([helper.params[pIndex]]), env: new Map() });
    }
    return mentionsPath(n, ctx) ? 'unknown' : 'na';
  }
  return mentionsPath(n, ctx) ? 'unknown' : 'na';
}

function callbackExpr(fn: SyntaxNode): SyntaxNode | null {
  const body = fn.childForFieldName('body');
  if (!body) return null;
  if (body.type !== 'statement_block') return body;
  const stmts = body.namedChildren.filter((s) => s.type !== 'comment');
  return stmts.length === 1 && stmts[0].type === 'return_statement' ? (stmts[0].namedChildren[0] ?? null) : null;
}

function mentionsPath(n: SyntaxNode, ctx: EvalCtx): boolean {
  if (/\bpathname\b|nextUrl/.test(n.text)) return true;
  for (const id of ctx.pathIds) if (wordRe(id).test(n.text)) return true;
  return false;
}

/** A string literal, a template literal over bound values, or a bound identifier. */
function stringValue(n: SyntaxNode, ctx: EvalCtx): string | null {
  if (n.type === 'string') return n.text.slice(1, -1);
  if (n.type === 'identifier') return ctx.env.get(n.text) ?? null;
  if (n.type === 'template_string') {
    let out = '';
    for (const c of n.children) {
      if (c.type === '`') continue;
      if (c.type === 'template_substitution') {
        const inner = c.namedChildren[0];
        const v = inner ? stringValue(inner, ctx) : null;
        if (v === null) return null;
        out += v;
      } else out += c.text;
    }
    return out;
  }
  return null;
}

/** A module-level `const NAME = ['a', 'b']` (optionally `as const`) in the same file. */
function constStrings(n: SyntaxNode, file: string, next: NextAdapter): string[] | null {
  if (n.type !== 'identifier') return null;
  const root = next.parsed.get(file)?.tree.rootNode;
  for (const top of root?.namedChildren ?? []) {
    const decl = top.type === 'export_statement' ? (top.childForFieldName('declaration') ?? top.namedChildren[0]) : top;
    if (decl?.type !== 'lexical_declaration') continue;
    for (const d of decl.namedChildren) {
      if (d.type !== 'variable_declarator' || d.childForFieldName('name')?.text !== n.text) continue;
      let v = d.childForFieldName('value');
      if (v?.type === 'as_expression' || v?.type === 'satisfies_expression') v = v.namedChildren[0];
      if (v?.type !== 'array') return null;
      const out: string[] = [];
      for (const el of v.namedChildren) {
        if (el.type === 'comment') continue;
        if (el.type !== 'string') return null;
        out.push(el.text.slice(1, -1));
      }
      return out;
    }
  }
  return null;
}

/** `function name(a, b) { return <expr> }` or `const name = (a) => <expr>` in the same file. */
function singleReturn(file: string, name: string, next: NextAdapter): { params: string[]; expr: SyntaxNode } | null {
  const root = next.parsed.get(file)?.tree.rootNode;
  for (const top of root?.namedChildren ?? []) {
    const decl = top.type === 'export_statement' ? (top.childForFieldName('declaration') ?? top.namedChildren[0]) : top;
    let fn: SyntaxNode | null = null;
    if (decl?.type === 'function_declaration' && decl.childForFieldName('name')?.text === name) fn = decl;
    if (decl?.type === 'lexical_declaration') {
      for (const d of decl.namedChildren) if (d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name) fn = d.childForFieldName('value');
    }
    if (!fn || !FUNCTION_TYPES.has(fn.type)) continue;
    const single = fn.childForFieldName('parameter');
    const params = single ? [single.text] : (fn.childForFieldName('parameters')?.namedChildren ?? []).map((p) => (p.childForFieldName('pattern') ?? p.namedChildren[0] ?? p).text);
    const expr = callbackExpr(fn);
    return expr ? { params, expr } : null;
  }
  return null;
}

/** A concrete sample path for a Next.js route pattern ("/api/items/[id]" -> "/api/items/x"). */
export function samplePath(route: string): string {
  return route.replace(/\[\[\.\.\.[^\]]+\]\]/g, '').replace(/\[\.\.\.[^\]]+\]/g, 'x').replace(/\[[^\]]+\]/g, 'x').replace(/\/+$/, '') || '/';
}

/** Nodes are found again by id. */
export function nodeIndex(graph: Graph): Map<string, Graph['nodes'][number]> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

// ---------------------------------------------------------------------------------------------
// Putting it together: one finding per route handler and per server action.

export interface NextAnalysis {
  endpoints: Map<string, NextFinding>;
  actions: NextFinding[];
  middleware: MiddlewareReport | null;
  /** 'use server' functions declared inside other functions (not graph nodes, not analyzed). */
  inlineActions: number;
}

const MIDDLEWARE_FILE = /^(src\/)?(middleware|proxy)\.(ts|tsx|js|jsx|mjs)$/;

/** Weakest first: what a per-method handler is summarized by. */
const STATE_RANK: Record<ProtectionState, number> = { none: 0, unknown: 1, public: 2, signed: 3, authenticated: 4, authorization: 5 };

export function analyzeNext(next: NextAdapter, graph: Graph): NextAnalysis {
  const sec = new NextSecurity(next, graph);
  // Next.js reads middleware.ts / proxy.ts next to the app or pages directory (src/ when they live there),
  // and proxy.ts (Next.js 16) over middleware.ts.
  const files = [...next.parsed.keys()].sort();
  const inSrc = files.some((f) => /^src\/(app|pages)\//.test(f)) && !files.some((f) => /^(app|pages)\//.test(f));
  const mwFiles = files.filter((f) => MIDDLEWARE_FILE.test(f));
  const mwFile = mwFiles.filter((f) => f.startsWith('src/') === inSrc).sort((a, b) => Number(!/proxy\./.test(a)) - Number(!/proxy\./.test(b)))[0];
  const mw = mwFile ? new MiddlewareGates(sec, next, mwFile, mwFiles.filter((f) => f !== mwFile)) : null;
  const handlerOf = new Map<string, string>();
  for (const e of graph.edges) if (e.kind === 'handles' && e.source.startsWith('endpoint:next:')) handlerOf.set(e.source, e.target);

  const endpoints = new Map<string, NextFinding>();
  for (const node of graph.nodes) {
    if (node.kind !== 'endpoint' || node.server !== 'next') continue;
    const f: NextFinding = { id: node.id, signals: [], unknown: [], notes: [] };
    const handler = handlerOf.get(node.id);
    const method = (node.method ?? 'GET').split('|')[0];
    const groups = handler ? handlerGroups(sec, next, handler, method === 'ANY' ? 'default' : method) : [];
    if (groups.length > 1 || groups[0]?.method) {
      // One export, several methods: each is decided on its own and the weakest is shown, so a public GET
      // is not hidden behind an authenticated POST.
      const decided = groups.map((g) => {
        const sub: NextFinding = { id: node.id, signals: [], unknown: [...g.unknown], notes: [] };
        for (const fn of g.fns) addFnSignals(sec, fn.ref, sub, fn.source);
        return { g, sub, state: decide(sub.signals, sub.unknown, 'medium').state };
      });
      const weakest = [...decided].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])[0];
      f.signals.push(...weakest.sub.signals);
      f.unknown.push(...weakest.sub.unknown);
      f.notes.push(...weakest.sub.notes, `handled per method: ${decided.map((d) => `${d.g.method} ${d.state}`).join(', ')}; the weakest (${weakest.g.method}) is shown`);
    } else if (groups.length) {
      f.unknown.push(...groups[0].unknown);
      for (const fn of groups[0].fns) addFnSignals(sec, fn.ref, f, fn.source);
    }
    if (!groups.some((g) => g.fns.length) && !f.unknown.length) f.unknown.push({ reason: 'next-handler-not-found', text: `${node.file ?? ''}: ${method} handler function not found` });
    if (mw && node.path) addMiddlewareSignals(mw, samplePath(node.path), f);
    endpoints.set(node.id, f);
  }

  // Server actions: exported functions of 'use server' files.
  const actions: NextFinding[] = [];
  let inlineActions = 0;
  for (const [rel, info] of [...next.infos].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const root = next.parsed.get(rel)?.tree.rootNode;
    if (!root) continue;
    const fileDirective = isUseServer(root.namedChildren[0]);
    if (!fileDirective) {
      if (next.parsed.get(rel)!.source.includes('use server')) {
        for (const b of root.descendantsOfType('statement_block')) if (isUseServer(b.namedChildren[0])) inlineActions++;
      }
      continue;
    }
    for (const [exported, ex] of info.exports) {
      if (ex.kind !== 'local') continue;
      const top = info.top.get(ex.local);
      if (top?.kind !== 'def') continue;
      const id = `fe:${rel}#${top.key}`;
      if (!graph.nodes.some((n) => n.id === id)) continue;
      const ref = sec.defFunction(rel, top.key);
      const f: NextFinding = { id, signals: [], unknown: [], notes: [`server action ${exported}() in ${rel}`] };
      if (ref) addFnSignals(sec, ref, f, 'handler');
      else f.unknown.push({ reason: 'next-handler-not-found', text: `${rel}: ${exported} is not a function CodeMap could read` });
      actions.push(f);
    }
  }
  actions.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { endpoints, actions, middleware: mw?.report ?? null, inlineActions };
}

function isUseServer(n: SyntaxNode | undefined): boolean {
  const s = n?.type === 'expression_statement' ? n.namedChildren[0] : null;
  return s?.type === 'string' && s.text.slice(1, -1) === 'use server';
}

type HandlerFn = { ref: FnRef; source: Signal['source'] };
/** The functions behind one handler. `method` is set when one export dispatches by method (`{ GET: ..., POST: ... }`). */
type HandlerGroup = { method: string | null; fns: HandlerFn[]; unknown: NextFinding['unknown'] };

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** The functions to read for a handler: its definition, or for `export const GET = wrapper(fn)` the wrapper and fn. */
function handlerGroups(sec: NextSecurity, next: NextAdapter, handler: string, method: string): HandlerGroup[] {
  const m = /^fe:(.+?)(?:#(.+))?$/.exec(handler);
  if (!m) return [];
  const [, file, key] = m;
  if (key) {
    const ref = sec.defFunction(file, key);
    return ref ? [{ method: null, fns: [{ ref, source: 'handler' }], unknown: [] }] : [];
  }
  // The export is not a plain function: look at its declaration.
  const root = next.parsed.get(file)?.tree.rootNode;
  for (const top of root?.namedChildren ?? []) {
    if (top.type !== 'export_statement') continue;
    const isDefault = top.children.some((c) => c.type === 'default');
    const decl = top.childForFieldName('declaration') ?? top.childForFieldName('value') ?? top.namedChildren[0];
    let value: SyntaxNode | null = null;
    if (isDefault && method === 'default') value = decl;
    else if (decl?.type === 'lexical_declaration') {
      for (const d of decl.namedChildren) if (d.type === 'variable_declarator' && boundNames(d.childForFieldName('name')).includes(method)) value = d.childForFieldName('value');
    }
    value = unwrapAwait(value);
    if (!value) continue;
    // export const { GET, POST } = handlers (NextAuth v5): the library's own sign-in, callback and session routes.
    if (value.type === 'identifier' && sec.nextAuthBinding(file, value.text)) {
      return [{ method: null, fns: [], unknown: [{ reason: 'auth-library-route', text: `${method} in ${file} is NextAuth's own route (${value.text})` }] }];
    }
    if (FUNCTION_TYPES.has(value.type)) return [{ method: null, fns: [{ ref: { node: value, file }, source: 'handler' }], unknown: [] }];
    if (value.type !== 'call_expression') continue;
    // export default withMiddlewares({ GET: createAuthedRoute({...}), POST: handlePost }): one group per method,
    // each with the dispatcher (it runs for all of them) and its own entry.
    const dispatch = value.childForFieldName('arguments')?.namedChildren.find((a) => a.type === 'object' && methodPairs(a).length > 0);
    if (dispatch) {
      const shared: HandlerGroup = { method: null, fns: [], unknown: [] };
      wrapperFunctions(sec, value, file, method, shared, dispatch);
      return methodPairs(dispatch).map(([verb, v]) => {
        const g: HandlerGroup = { method: verb, fns: [...shared.fns], unknown: [...shared.unknown] };
        const entry = unwrapAwait(v);
        if (entry && FUNCTION_TYPES.has(entry.type)) g.fns.push({ ref: { node: entry, file }, source: 'handler' });
        else if (entry?.type === 'call_expression') wrapperFunctions(sec, entry, file, verb, g);
        else if (entry?.type === 'identifier' && sec.resolveHelper(file, entry.text)) g.fns.push({ ref: sec.resolveHelper(file, entry.text)!, source: 'handler' });
        else g.unknown.push({ reason: 'next-handler-not-found', text: `${verb} in ${file}: ${firstLine(v, 50)} is not a function CodeMap could read` });
        return g;
      });
    }
    const g: HandlerGroup = { method: null, fns: [], unknown: [] };
    wrapperFunctions(sec, value, file, method, g);
    return [g];
  }
  return [];
}

/** `{ GET: ..., POST: ... }` entries, in source order. */
function methodPairs(obj: SyntaxNode): [string, SyntaxNode][] {
  const out: [string, SyntaxNode][] = [];
  for (const p of obj.namedChildren) {
    const k = p.type === 'pair' ? p.childForFieldName('key')?.text.replace(/['"]/g, '') : undefined;
    const v = p.childForFieldName('value');
    if (k && v && HTTP_METHODS.has(k)) out.push([k, v]);
  }
  return out;
}

/**
 * `wrapper(fn)` / `wrapper({ fn: async () => ... })`: the functions passed in, the wrapper, and the functions
 * it returns (`return async (req) => ...`, or `const handler = async (req) => ...; return handler`).
 */
function wrapperFunctions(sec: NextSecurity, call: SyntaxNode, file: string, label: string, g: HandlerGroup, skip?: SyntaxNode, depth = 0): void {
  for (const a of call.childForFieldName('arguments')?.namedChildren ?? []) {
    if (FUNCTION_TYPES.has(a.type)) g.fns.push({ ref: { node: a, file }, source: 'handler' });
    else if (a.type === 'object' && a.startIndex !== skip?.startIndex) {
      for (const p of a.namedChildren) {
        const v = p.type === 'pair' ? p.childForFieldName('value') : p.type === 'method_definition' ? p : null;
        if (v && FUNCTION_TYPES.has(v.type)) g.fns.push({ ref: { node: v, file }, source: 'handler' });
      }
    }
  }
  const callee = call.childForFieldName('function');
  const wrapper = callee ? sec.resolveCallee(file, callee) : null;
  if (!wrapper) {
    g.unknown.push({ reason: 'wrapper-not-analyzed', text: `${label} = ${firstLine(callee ?? call, 50)}(...) in ${file}: the wrapper could not be read` });
    return;
  }
  g.fns.push({ ref: wrapper, source: 'called-code' });
  const body = wrapper.node.childForFieldName('body');
  if (body && FUNCTION_TYPES.has(body.type)) g.fns.push({ ref: { node: body, file: wrapper.file }, source: 'called-code' });
  // A wrapper made of another one: `createUnstableRoute = (cfg) => createAuthedRoute({ ...cfg })`.
  const inner = unwrapAwait(body);
  if (inner?.type === 'call_expression' && depth < 2) wrapperFunctions(sec, inner, wrapper.file, label, g, undefined, depth + 1);
  const locals = (body ?? wrapper.node).descendantsOfType('variable_declarator');
  const returned = (x: SyntaxNode | null) => {
    if (x && FUNCTION_TYPES.has(x.type)) g.fns.push({ ref: { node: x, file: wrapper.file }, source: 'called-code' });
    else if (x?.type === 'identifier') {
      const v = unwrapAwait(locals.find((d) => d.childForFieldName('name')?.text === x.text)?.childForFieldName('value') ?? null);
      if (v && FUNCTION_TYPES.has(v.type)) g.fns.push({ ref: { node: v, file: wrapper.file }, source: 'called-code' });
    }
  };
  for (const n of scope(body ?? wrapper.node, RETURN_NODES)) {
    const ret = n.type === 'return_statement' ? unwrapAwait(n.namedChildren[0] ?? null) : null;
    // `return Object.assign(handler, {...})`, `return withCors(handler)`: the function travels as an argument.
    // `return createAuthedRoute({...})`: the wrapper is another wrapper.
    if (ret?.type === 'call_expression') {
      for (const a of ret.childForFieldName('arguments')?.namedChildren ?? []) returned(a);
      const callee = calleeOf(ret);
      if (depth < 2 && callee && callee.text !== 'Object.assign' && sec.resolveCallee(wrapper.file, callee)) wrapperFunctions(sec, ret, wrapper.file, label, g, undefined, depth + 1);
    } else returned(ret);
  }
}

function addFnSignals(sec: NextSecurity, ref: FnRef, f: NextFinding, source: Signal['source']): void {
  const r = sec.analyzeFn(ref);
  for (const g of r.guards) {
    f.signals.push({
      effect: g.kind,
      source,
      text: g.text,
      detail:
        (g.secret
          ? 'denies the request without the shared secret / signature'
          : `${g.strong ? 'denies the request' : 'returns early (what it returns instead was not judged)'}${g.via ? ` when ${g.via} finds no ${g.kind === 'authorization' ? 'permission' : 'user'}` : ''}`) +
        (source === 'called-code' ? ', in a wrapper or helper' : '') +
        '; whether every path reaches it was not checked',
      confidence: g.confidence,
      file: g.file,
      line: g.line,
    });
  }
  for (const c of r.enforcingCalls) {
    f.signals.push({
      effect: c.role ? 'authorization' : 'authentication',
      source: 'called-code',
      text: `${c.name}()`,
      detail: 'helper that denies the request itself (throws or redirects)',
      confidence: c.confidence === 'medium' ? 'medium' : 'low',
      file: c.file,
      line: c.line,
    });
  }
  for (const v of r.unguarded) f.unknown.push({ reason: 'check-in-code', text: `${v.via}() is read but no guard denies the request without it (${v.file}:${v.line})` });
  for (const u of r.unfollowed) {
    f.unknown.push({
      reason: 'unresolved-auth-helper',
      text: u.checked
        ? `${u.name}() decides whether the request goes on, but what it checks could not be told (${u.file}:${u.line})`
        : `${u.name}() could not be followed (${u.file}:${u.line})`,
    });
  }
}

function addMiddlewareSignals(mw: MiddlewareGates, path: string, f: NextFinding): void {
  const covered = mw.covers(path);
  if (covered === 'no') return;
  const { applies, unevaluated } = mw.gatesFor(path);
  for (const g of covered === 'yes' ? applies : []) {
    f.signals.push({
      effect: g.kind,
      source: 'middleware',
      text: g.text,
      detail: `${mw.report.file} denies requests for ${path} without ${g.kind === 'authorization' ? 'the right role' : 'a signed-in user'}${g.via ? ` (${g.via})` : ''}`,
      confidence: 'medium',
      file: g.file,
      line: g.line,
    });
  }
  if (covered === 'conditional') {
    // The client decides whether those headers or cookies are there: a gate it can skip is not protection.
    for (const g of [...applies, ...unevaluated]) f.notes.push(`${g.text} in ${g.file}:${g.line} would apply to ${path}, but its matcher entry has has/missing conditions a request can avoid; not counted`);
    return;
  }
  const maybe = covered === 'unknown' ? [...applies, ...unevaluated] : unevaluated;
  for (const g of maybe) f.unknown.push({ reason: 'middleware-unevaluated', text: `${g.text} in ${g.file}:${g.line} may apply to ${path}` });
}
