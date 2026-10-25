import type { PhpClass } from '../lang/php/extract.js';
import type { PhpScope } from '../lang/php/names.js';
import type { SyntaxNode } from '../parse.js';
import { FORM_REQUEST } from './catalog.js';
import { firstLine, type PhpIndex } from './php.js';

/**
 * An access check written in handler code.
 * - throwing: stops the request when it fails ($this->authorize, Gate::authorize)
 * - enforced: a boolean check whose failure branch aborts or throws (abort_unless(Gate::allows(...)), if (cannot) abort(403))
 * - conditional: a boolean check used some other way (maybe display logic)
 * - login: Auth::check() / auth()->guest() style checks
 */
export interface CodeCheck {
  kind: 'throwing' | 'enforced' | 'conditional' | 'login';
  text: string;
  file: string;
  line: number;
}

const GATE = 'illuminate\\support\\facades\\gate';
const AUTH = 'illuminate\\support\\facades\\auth';
const GATE_THROWING = new Set(['authorize', 'allowif', 'denyif']);
const GATE_BOOLEAN = new Set(['allows', 'denies', 'check', 'any', 'none', 'inspect']);
const ABORTING = new Set(['abort_if', 'abort_unless', 'throw_if', 'throw_unless']);
/** Cheap text test before walking a body: every check below contains one of these. */
const MAYBE_CHECK = /authorize|allow|deny|denies|inspect|->\s*can(not|t)?\s*\(|check\s*\(|guest\s*\(|any\s*\(|none\s*\(/i;

function isFacade(node: SyntaxNode | null, scope: PhpScope, fqnLower: string, short: string): boolean {
  if (!node) return false;
  const t = node.text.replace(/^\\/, '');
  return t === short || scope.resolveClass(node.text).toLowerCase() === fqnLower;
}

/** Root of a call chain: `Gate::forUser($u)->authorize()` -> the `Gate::forUser($u)` scoped call. */
function chainRoot(n: SyntaxNode): SyntaxNode {
  let cur = n;
  while ((cur.type === 'member_call_expression' || cur.type === 'nullsafe_member_call_expression') && cur.childForFieldName('object')) cur = cur.childForFieldName('object')!;
  return cur;
}

function aborts(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (node.descendantsOfType(['throw_expression', 'throw_statement']).length) return true;
  return node.descendantsOfType('function_call_expression').some((c) => {
    const fn = c.childForFieldName('function')?.text;
    return fn === 'abort' || fn === 'abort_if' || fn === 'abort_unless';
  });
}

/** Is the boolean check `node` used to abort the request? */
function enforcedBy(node: SyntaxNode, body: SyntaxNode): boolean {
  let child = node;
  for (let p = node.parent; p && p.id !== body.id; child = p, p = p.parent) {
    if (p.type === 'arguments') {
      const call = p.parent;
      const fn = call?.type === 'function_call_expression' ? call.childForFieldName('function')?.text : null;
      if (fn && ABORTING.has(fn)) return p.namedChildren[0]?.id === child.id;
    }
    if (p.type === 'if_statement') {
      const cond = p.childForFieldName('condition');
      return cond?.id === child.id && aborts(p.childForFieldName('body'));
    }
    if (p.type === 'expression_statement' || p.type === 'compound_statement') return false;
  }
  return false;
}

/** Access checks written directly in one function body (not in the functions it calls). */
export function scanChecks(body: SyntaxNode, scope: PhpScope, file: string): CodeCheck[] {
  const out: CodeCheck[] = [];
  if (!MAYBE_CHECK.test(body.text)) return out;
  const add = (kind: CodeCheck['kind'], n: SyntaxNode) => out.push({ kind, text: firstLine(n), file, line: n.startPosition.row + 1 });
  const boolean = (n: SyntaxNode) => add(enforcedBy(n, body) ? 'enforced' : 'conditional', n);
  for (const n of body.descendantsOfType(['member_call_expression', 'nullsafe_member_call_expression', 'scoped_call_expression'])) {
    const name = n.childForFieldName('name')?.text.toLowerCase() ?? '';
    if (n.type === 'scoped_call_expression') {
      const s = n.childForFieldName('scope');
      if (isFacade(s, scope, GATE, 'Gate')) {
        if (GATE_THROWING.has(name)) add('throwing', n);
        else if (GATE_BOOLEAN.has(name)) boolean(n);
      } else if (isFacade(s, scope, AUTH, 'Auth') && (name === 'check' || name === 'guest')) add('login', n);
      continue;
    }
    const obj = n.childForFieldName('object');
    if ((name === 'authorize' || name === 'authorizeforuser') && obj?.type === 'variable_name' && obj.text === '$this') {
      add('throwing', n);
      continue;
    }
    const root = chainRoot(n);
    const rootIsGate = root.type === 'scoped_call_expression' && isFacade(root.childForFieldName('scope'), scope, GATE, 'Gate');
    if (rootIsGate && root.id !== n.id) {
      if (name === 'authorize') add('throwing', n);
      else if (GATE_BOOLEAN.has(name)) boolean(n);
      continue;
    }
    if (name === 'can' || name === 'cannot' || name === 'cant') {
      boolean(n);
      continue;
    }
    if (name === 'check' || name === 'guest') {
      const authCall = root.type === 'function_call_expression' && root.childForFieldName('function')?.text === 'auth';
      const authFacade = root.type === 'scoped_call_expression' && isFacade(root.childForFieldName('scope'), scope, AUTH, 'Auth');
      if (authCall || authFacade) add('login', n);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

export interface FormRequestUse {
  cls: PhpClass;
  file: string;
  line: number;
  /** 'missing': no authorize() (Laravel allows); 'true': returns a literal true; 'check': anything else (not evaluated). */
  authorize: 'missing' | 'true' | 'check';
  authorizeLine?: number;
  authorizeFile?: string;
}

/** FormRequest subclasses type-hinted on the handler's parameters. */
export function formRequests(fn: SyntaxNode, scope: PhpScope, index: PhpIndex): FormRequestUse[] {
  const params = fn.childForFieldName('parameters');
  if (!params) return [];
  const out: FormRequestUse[] = [];
  for (const p of params.namedChildren) {
    const type = p.childForFieldName('type');
    const named = type?.type === 'named_type' ? type.namedChildren[0] : null;
    if (!named) continue;
    const cls = index.findClass(scope.resolveClass(named.text));
    if (!cls || !index.isA(cls, FORM_REQUEST)) continue;
    const file = index.fileOf(cls) ?? '';
    const m = index.findMethod(cls, 'authorize');
    let authorize: FormRequestUse['authorize'] = 'missing';
    if (m) {
      const stmts = m.node.childForFieldName('body')?.namedChildren.filter((s) => s.type !== 'comment') ?? [];
      const onlyReturn = stmts.length === 1 && stmts[0].type === 'return_statement' ? stmts[0].namedChildren[0] : null;
      authorize = onlyReturn?.type === 'boolean' && onlyReturn.text.toLowerCase() === 'true' ? 'true' : 'check';
    }
    out.push({ cls, file, line: cls.line, authorize, authorizeLine: m ? m.node.startPosition.row + 1 : undefined, authorizeFile: m?.file });
  }
  return out;
}
