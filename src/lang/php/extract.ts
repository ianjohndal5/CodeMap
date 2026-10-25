import { type SyntaxNode, loadQuery } from '../../parse.js';
import { SpanIndex } from '../../util/ranges.js';
import { PhpScope, applyUseDeclaration, type UseStatement } from './names.js';

export type PhpClassKind = 'class' | 'interface' | 'trait' | 'enum';

export interface PhpMethod {
  name: string;
  line: number;
  visibility: string;
  static: boolean;
}

export interface PhpClass {
  fqn: string;
  name: string;
  kind: PhpClassKind;
  line: number;
  methods: PhpMethod[];
  extends: string[];
  implements: string[];
  traits: string[];
  /** Declared property types: typed properties and constructor-promoted parameters. */
  propTypes: Map<string, string>;
  /** Graph id, assigned during resolution (handles duplicate FQNs). */
  id?: string;
}

export interface PhpFunction {
  fqn: string;
  name: string;
  line: number;
  id?: string;
}

export interface PhpClosure {
  line: number;
  col: number;
  startIndex: number;
}

/** Where a reference occurs. */
export type PhpOwner =
  | { type: 'file' }
  | { type: 'method'; cls: PhpClass; method: string }
  | { type: 'function'; fn: PhpFunction }
  | { type: 'closure'; closure: PhpClosure };

export type PhpRef =
  /** $this->m(): same class, uncertain when m is not defined there. */
  | { kind: 'this'; owner: PhpOwner; cls: string; method: string; line: number }
  /** self::m() / static::m(). */
  | { kind: 'self'; owner: PhpOwner; cls: string; method: string; line: number }
  /** ClassName::m(), $this->typedProp->m(), $typedParam->m(): method if defined, else the class. */
  | { kind: 'static' | 'typed'; owner: PhpOwner; cls: string; method: string; line: number }
  | { kind: 'new'; owner: PhpOwner; cls: string; line: number }
  | { kind: 'function'; owner: PhpOwner; candidates: string[]; line: number }
  | { kind: 'extends' | 'implements' | 'trait'; owner: PhpOwner; from: PhpClass; cls: string; line: number };

export interface PhpUnresolved {
  line: number;
  reason: string;
  text: string;
}

export interface PhpFileInfo {
  rel: string;
  namespaces: string[];
  useStatements: UseStatement[];
  classes: PhpClass[];
  functions: PhpFunction[];
  closures: PhpClosure[];
  refs: PhpRef[];
  unresolved: PhpUnresolved[];
  /** Namespace and imports in effect at a byte offset (in memory only; used by the security lens). */
  scopeAt?: (pos: number) => PhpScope;
  /** Syntax node of each class, method, function and closure, for line ranges when they are needed. */
  nodes: WeakMap<object, SyntaxNode>;
}

/** Last line of a definition recorded in `info.nodes` (computed on demand: it costs a native call). */
export function endLineOf(info: PhpFileInfo, def: object): number | undefined {
  const n = info.nodes.get(def);
  return n ? n.endPosition.row + 1 : undefined;
}

/** A method, function or route closure body that calls are attributed to. */
interface OwnerRange {
  start: number;
  end: number;
  owner: PhpOwner;
  cls: PhpClass | null;
  scope: PhpScope;
  params: SyntaxNode | null;
  body: SyntaxNode | null;
  /** Declared parameter types ($name -> FQN), minus reassigned ones; computed lazily. */
  typed?: Map<string, string>;
}

const CLASS_DECLS: Record<string, PhpClassKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'trait',
  enum_declaration: 'enum',
};

const line = (n: SyntaxNode) => n.startPosition.row + 1;
const short = (t: string) => (t.length > 80 ? t.slice(0, 77) + '...' : t);

/** FQN of a declared type when it is a single class type (nullable allowed). */
function declaredClass(typeNode: SyntaxNode | null, scope: PhpScope, cls: PhpClass | null): string | null {
  if (!typeNode) return null;
  let t: SyntaxNode | undefined = typeNode;
  if (t.type === 'optional_type') t = t.namedChildren[0];
  if (!t || t.type !== 'named_type') return null;
  const nameNode = t.namedChildren[0];
  if (!nameNode) return null;
  const written = nameNode.text;
  const lower = written.toLowerCase();
  if (lower === 'self' || lower === 'static') return cls?.fqn ?? null;
  if (lower === 'parent') return null;
  return scope.resolveClass(written);
}

/** Variables assigned anywhere in a body (their declared type can no longer be trusted). */
function assignedVars(body: SyntaxNode | null): Set<string> {
  const out = new Set<string>();
  if (!body) return out;
  for (const a of body.descendantsOfType(['assignment_expression', 'reference_assignment_expression'])) {
    const left = a.childForFieldName('left');
    if (left?.type === 'variable_name') out.add(left.text);
  }
  return out;
}

function paramTypes(range: OwnerRange): Map<string, string> {
  const out = new Map<string, string>();
  if (!range.params) return out;
  const reassigned = assignedVars(range.body);
  for (const p of range.params.namedChildren) {
    if (p.type !== 'simple_parameter' && p.type !== 'property_promotion_parameter') continue;
    const name = p.childForFieldName('name')?.text;
    const fqn = declaredClass(p.childForFieldName('type'), range.scope, range.cls);
    if (name && fqn && !reassigned.has(name)) out.set(name, fqn);
  }
  return out;
}

/**
 * Extract definitions and syntactically certain references from one PHP file.
 * Declarations and call sites are found with Tree-sitter queries; each call is
 * attributed to the innermost method / function / route closure containing it.
 * `routeClosures` maps start -> end offsets of closures used as route actions.
 */
/**
 * `keep`: also record definition nodes and scopes for later passes (the security lens). Off by
 * default: keeping them alive costs time on large projects even when nothing uses them.
 */
export function extractPhp(rel: string, root: SyntaxNode, routeClosures: Map<number, number> = new Map(), keep = false): PhpFileInfo {
  const info: PhpFileInfo = {
    rel,
    namespaces: [],
    useStatements: [],
    classes: [],
    functions: [],
    closures: [],
    refs: [],
    unresolved: [],
    nodes: new WeakMap(),
  };
  const fileOwner: PhpOwner = { type: 'file' };
  const owners: OwnerRange[] = [];

  // --- scopes: braced namespaces have a range, unbraced ones apply until the next one.
  const globalScope = new PhpScope();
  const scopes: PhpScope[] = [globalScope];
  const braced: { start: number; end: number; scope: PhpScope }[] = [];
  const unbraced: { start: number; scope: PhpScope }[] = [];
  const scopeAt = (pos: number): PhpScope => {
    for (let i = braced.length - 1; i >= 0; i--) if (pos >= braced[i].start && pos < braced[i].end) return braced[i].scope;
    for (let i = unbraced.length - 1; i >= 0; i--) if (unbraced[i].start <= pos) return unbraced[i].scope;
    return globalScope;
  };

  const handleClass = (node: SyntaxNode, kind: PhpClassKind) => {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const scope = scopeAt(node.startIndex);
    const name = nameNode.text;
    const fqn = scope.namespace ? `${scope.namespace}\\${name}` : name;
    const cls: PhpClass = { fqn, name, kind, line: line(node), methods: [], extends: [], implements: [], traits: [], propTypes: new Map() };
    if (keep) info.nodes.set(cls, node);
    info.classes.push(cls);
    const relation = (kindOfRel: 'extends' | 'implements' | 'trait', nameN: SyntaxNode) => {
      const target = scope.resolveClass(nameN.text);
      (kindOfRel === 'extends' ? cls.extends : kindOfRel === 'implements' ? cls.implements : cls.traits).push(target);
      info.refs.push({ kind: kindOfRel, owner: fileOwner, from: cls, cls: target, line: line(nameN) });
    };
    for (const c of node.namedChildren) {
      if (c.type === 'base_clause') {
        for (const n of c.namedChildren) if (n.type === 'name' || n.type === 'qualified_name') relation('extends', n);
      } else if (c.type === 'class_interface_clause') {
        for (const n of c.namedChildren) if (n.type === 'name' || n.type === 'qualified_name') relation('implements', n);
      }
    }
    const body = node.childForFieldName('body');
    if (!body) return;
    for (const m of body.namedChildren) {
      if (m.type === 'property_declaration') {
        const fqnType = declaredClass(m.childForFieldName('type'), scope, cls);
        if (!fqnType) continue;
        for (const el of m.namedChildren) {
          if (el.type !== 'property_element') continue;
          const v = el.childForFieldName('name')?.text;
          if (v) cls.propTypes.set(v.replace(/^\$/, ''), fqnType);
        }
      } else if (m.type === 'use_declaration') {
        for (const n of m.namedChildren) if (n.type === 'name' || n.type === 'qualified_name') relation('trait', n);
      } else if (m.type === 'method_declaration') {
        const mName = m.childForFieldName('name')?.text;
        if (!mName) continue;
        let visibility = 'public';
        let isStatic = false;
        for (const c of m.namedChildren) {
          if (c.type === 'visibility_modifier') visibility = c.text.toLowerCase();
          else if (c.type === 'static_modifier') isStatic = true;
        }
        const method: PhpMethod = { name: mName, line: line(m), visibility, static: isStatic };
        cls.methods.push(method);
        if (keep) info.nodes.set(method, m);
        const params = m.childForFieldName('parameters');
        if (mName.toLowerCase() === '__construct') {
          // Constructor-promoted parameters are declared, typed properties.
          for (const p of params?.namedChildren ?? []) {
            if (p.type !== 'property_promotion_parameter') continue;
            const v = p.childForFieldName('name')?.text;
            const fqnType = declaredClass(p.childForFieldName('type'), scope, cls);
            if (v && fqnType) cls.propTypes.set(v.replace(/^\$/, ''), fqnType);
          }
        }
        const mBody = m.childForFieldName('body');
        if (mBody) {
          owners.push({ start: m.startIndex, end: m.endIndex, owner: { type: 'method', cls, method: mName }, cls, scope, params, body: mBody });
        }
      }
    }
  };

  const handleFunction = (node: SyntaxNode) => {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const scope = scopeAt(node.startIndex);
    const fn: PhpFunction = { fqn: scope.namespace ? `${scope.namespace}\\${name}` : name, name, line: line(node) };
    if (keep) info.nodes.set(fn, node);
    info.functions.push(fn);
    owners.push({
      start: node.startIndex,
      end: node.endIndex,
      owner: { type: 'function', fn },
      cls: null,
      scope,
      params: node.childForFieldName('parameters'),
      body: node.childForFieldName('body'),
    });
  };

  // One query run (declarations + call sites) traverses the tree once; captures come back in document order.
  const captures = loadQuery('php', import.meta.url, 'queries/declarations.scm', 'queries/calls.scm').captures(root);

  // --- Pass 1: declarations, in document order.
  for (const { name: capture, node } of captures) {
    switch (capture) {
      case 'namespace': {
        const ns = node.childForFieldName('name')?.text ?? '';
        info.namespaces.push(ns);
        const s = new PhpScope();
        s.enterNamespace(ns);
        scopes.push(s);
        const body = node.childForFieldName('body');
        if (body) braced.push({ start: node.startIndex, end: node.endIndex, scope: s });
        else unbraced.push({ start: node.startIndex, scope: s });
        break;
      }
      case 'use':
        applyUseDeclaration(node, scopeAt(node.startIndex));
        break;
      case 'class':
        handleClass(node, CLASS_DECLS[node.type]);
        break;
      case 'function':
        handleFunction(node);
        break;
    }
  }
  for (const [start, end] of routeClosures) {
    const node = root.descendantForIndex(start);
    const closure: PhpClosure = { line: node.startPosition.row + 1, col: node.startPosition.column + 1, startIndex: start };
    if (keep) info.nodes.set(closure, node);
    info.closures.push(closure);
    owners.push({ start, end, owner: { type: 'closure', closure }, cls: null, scope: scopeAt(start), params: null, body: null });
  }
  info.closures.sort((a, b) => a.startIndex - b.startIndex);
  const ownerIndex = new SpanIndex(owners);

  // --- Pass 2: call sites.
  const unresolved = (n: SyntaxNode, reason: string) => {
    info.unresolved.push({ line: line(n), reason, text: short(n.text.split('\n')[0]) });
  };

  for (const { name: capture, node } of captures) {
    if (!capture.startsWith('call.')) continue;
    const range = ownerIndex.innermost(node.startIndex);
    const owner = range?.owner ?? fileOwner;
    const cls = range?.cls ?? null;
    const scope = range?.scope ?? scopeAt(node.startIndex);
    const typedVar = (v: string): string | undefined => {
      if (!range) return undefined;
      range.typed ??= paramTypes(range);
      return range.typed.get(v);
    };

    if (capture === 'call.member') {
      const object = node.childForFieldName('object');
      const nameNode = node.childForFieldName('name');
      if (!object || !nameNode) continue;
      if (nameNode.type !== 'name') {
        unresolved(node, 'dynamic-method-name');
        continue;
      }
      const method = nameNode.text;
      if (object.type === 'variable_name') {
        const v = object.text;
        if (v === '$this') {
          if (cls) info.refs.push({ kind: 'this', owner, cls: cls.fqn, method, line: line(node) });
          continue;
        }
        const typed = typedVar(v);
        if (typed) info.refs.push({ kind: 'typed', owner, cls: typed, method, line: line(node) });
        else unresolved(node, 'untyped-variable');
        continue;
      }
      if (object.type === 'member_access_expression' || object.type === 'nullsafe_member_access_expression') {
        const inner = object.childForFieldName('object');
        const prop = object.childForFieldName('name');
        if (inner?.text === '$this' && prop?.type === 'name' && cls) {
          const typed = cls.propTypes.get(prop.text);
          if (typed) info.refs.push({ kind: 'typed', owner, cls: typed, method, line: line(node) });
          else unresolved(node, 'untyped-property');
          continue;
        }
        unresolved(node, 'untyped-property');
        continue;
      }
      // Receiver is the result of another call (fluent chains) or something more dynamic.
      unresolved(node, 'chained-call');
    } else if (capture === 'call.scoped') {
      const scopeNode = node.childForFieldName('scope');
      const nameNode = node.childForFieldName('name');
      if (!scopeNode || !nameNode) continue;
      if (nameNode.type !== 'name') {
        unresolved(node, 'dynamic-method-name');
        continue;
      }
      const method = nameNode.text;
      if (scopeNode.type === 'relative_scope') {
        if (scopeNode.text.toLowerCase() === 'parent') unresolved(node, 'parent-call');
        else if (cls) info.refs.push({ kind: 'self', owner, cls: cls.fqn, method, line: line(node) });
      } else if (scopeNode.type === 'name' || scopeNode.type === 'qualified_name') {
        info.refs.push({ kind: 'static', owner, cls: scope.resolveClass(scopeNode.text), method, line: line(node) });
      } else unresolved(node, 'dynamic-class');
    } else if (capture === 'call.new') {
      const target = node.namedChildren[0];
      if (!target) continue;
      if (target.type === 'name' || target.type === 'qualified_name') {
        const lower = target.text.toLowerCase();
        if (lower === 'static' || lower === 'self') {
          if (cls) info.refs.push({ kind: 'new', owner, cls: cls.fqn, line: line(node) });
        } else if (lower !== 'parent') {
          info.refs.push({ kind: 'new', owner, cls: scope.resolveClass(target.text), line: line(node) });
        }
      } else if (target.type !== 'anonymous_class') unresolved(node, 'dynamic-class');
    } else if (capture === 'call.function') {
      const fn = node.childForFieldName('function');
      // Calls through variables ($fn()) are closures/callables: not resolvable, not counted.
      if (fn && (fn.type === 'name' || fn.type === 'qualified_name')) {
        info.refs.push({ kind: 'function', owner, candidates: scope.resolveFunction(fn.text), line: line(node) });
      }
    }
  }

  for (const s of scopes) info.useStatements.push(...s.useStatements);
  info.useStatements.sort((a, b) => a.line - b.line);
  if (keep) info.scopeAt = scopeAt;
  return info;
}
