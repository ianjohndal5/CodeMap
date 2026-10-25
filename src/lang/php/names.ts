import type { SyntaxNode } from '../../parse.js';

/** Fully-qualified names never carry the leading backslash. */
export function stripLeadingSlash(name: string): string {
  return name.startsWith('\\') ? name.slice(1) : name;
}

export interface UseStatement {
  fqn: string;
  line: number;
}

/**
 * Namespace + `use` imports in effect at some point of a PHP file. Class and
 * function names are case-insensitive in PHP, so alias keys are lower-cased.
 */
export class PhpScope {
  namespace = '';
  private classUses = new Map<string, string>();
  private functionUses = new Map<string, string>();
  readonly useStatements: UseStatement[] = [];

  /** Start a new namespace (the unbraced form resets imports). */
  enterNamespace(ns: string): void {
    this.namespace = ns;
    this.classUses = new Map();
    this.functionUses = new Map();
  }

  clone(): PhpScope {
    const s = new PhpScope();
    s.namespace = this.namespace;
    s.classUses = new Map(this.classUses);
    s.functionUses = new Map(this.functionUses);
    return s;
  }

  addUse(fqn: string, alias: string | null, kind: 'class' | 'function' | 'const', line: number): void {
    const clean = stripLeadingSlash(fqn);
    const key = (alias ?? clean.split('\\').pop() ?? clean).toLowerCase();
    if (kind === 'class') {
      this.classUses.set(key, clean);
      this.useStatements.push({ fqn: clean, line });
    } else if (kind === 'function') {
      this.functionUses.set(key, clean);
    }
  }

  /** Resolve a class name as written in source to a fully-qualified name. */
  resolveClass(written: string): string {
    if (written.startsWith('\\')) return written.slice(1);
    if (written.toLowerCase().startsWith('namespace\\')) return this.qualify(written.slice('namespace\\'.length));
    const slash = written.indexOf('\\');
    if (slash >= 0) {
      const first = written.slice(0, slash).toLowerCase();
      const alias = this.classUses.get(first);
      return alias ? alias + written.slice(slash) : this.qualify(written);
    }
    return this.classUses.get(written.toLowerCase()) ?? this.qualify(written);
  }

  /** Candidate FQNs for a function call: imported, namespaced, then global (PHP's fallback rule). */
  resolveFunction(written: string): string[] {
    if (written.startsWith('\\')) return [written.slice(1)];
    if (written.includes('\\')) return [this.resolveClass(written)];
    const imported = this.functionUses.get(written.toLowerCase());
    if (imported) return [imported];
    return this.namespace ? [`${this.namespace}\\${written}`, written] : [written];
  }

  private qualify(name: string): string {
    return this.namespace ? `${this.namespace}\\${name}` : name;
  }
}

/** Apply one namespace_use_declaration node to the scope. */
export function applyUseDeclaration(node: SyntaxNode, scope: PhpScope): void {
  // `use function` / `use const`: the keyword sits on the clause (or on the declaration in older grammars).
  const kindOf = (n: SyntaxNode): 'class' | 'function' | 'const' | null => {
    for (const c of n.children) {
      if (c.type === 'function') return 'function';
      if (c.type === 'const') return 'const';
    }
    return null;
  };
  const declKind = kindOf(node);
  const line = node.startPosition.row + 1;
  const group = node.childForFieldName('body');
  if (group && group.type === 'namespace_use_group') {
    const prefixNode = node.namedChildren.find((c) => c.type === 'namespace_name' || c.type === 'name' || c.type === 'qualified_name');
    const prefix = prefixNode ? stripLeadingSlash(prefixNode.text) : '';
    for (const clause of group.namedChildren) {
      if (clause.type !== 'namespace_use_clause') continue;
      const { name, alias } = useClauseParts(clause);
      if (name) scope.addUse(prefix ? `${prefix}\\${name}` : name, alias, kindOf(clause) ?? declKind ?? 'class', line);
    }
    return;
  }
  for (const clause of node.namedChildren) {
    if (clause.type !== 'namespace_use_clause') continue;
    const { name, alias } = useClauseParts(clause);
    if (name) scope.addUse(name, alias, kindOf(clause) ?? declKind ?? 'class', line);
  }
}

function useClauseParts(clause: SyntaxNode): { name: string | null; alias: string | null } {
  const aliasNode = clause.childForFieldName('alias');
  let name: string | null = null;
  for (const c of clause.namedChildren) {
    if (aliasNode && c.id === aliasNode.id) continue;
    if (c.type === 'qualified_name' || c.type === 'name' || c.type === 'namespace_name') {
      name = c.text;
      break;
    }
  }
  return { name, alias: aliasNode ? aliasNode.text : null };
}

/**
 * Collect the namespace and imports declared at the top level of a file. Good
 * enough for route files and bootstrap files, which use a single namespace.
 */
export function collectFileScope(root: SyntaxNode): PhpScope {
  const scope = new PhpScope();
  for (const c of root.namedChildren) {
    if (c.type === 'namespace_definition') {
      const name = c.childForFieldName('name');
      scope.enterNamespace(name ? name.text : '');
      const body = c.childForFieldName('body');
      if (body) for (const s of body.namedChildren) if (s.type === 'namespace_use_declaration') applyUseDeclaration(s, scope);
    } else if (c.type === 'namespace_use_declaration') {
      applyUseDeclaration(c, scope);
    }
  }
  return scope;
}

/** Literal value of a PHP string node ('...' or "..." without interpolation), else null. */
export function phpString(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'string' || node.type === 'encapsed_string') {
    let out = '';
    for (const c of node.namedChildren) {
      if (c.type === 'string_content' || c.type === 'string_value') out += c.text;
      else if (c.type === 'escape_sequence') out += unescape(c.text);
      else return null; // interpolation
    }
    if (node.namedChildCount === 0) {
      // Empty string or grammar versions without content children.
      const t = node.text;
      return t.length >= 2 ? t.slice(1, -1) : '';
    }
    return node.type === 'string' ? out.replace(/\\(['\\])/g, '$1') : out;
  }
  if (node.type === 'binary_expression') {
    const op = node.children.find((c) => !c.isNamed)?.text;
    if (op !== '.') return null;
    const l = phpString(node.childForFieldName('left'));
    const r = phpString(node.childForFieldName('right'));
    return l !== null && r !== null ? l + r : null;
  }
  if (node.type === 'parenthesized_expression') return phpString(node.namedChildren[0]);
  return null;
}

function unescape(seq: string): string {
  switch (seq) {
    case '\\n':
      return '\n';
    case '\\t':
      return '\t';
    case '\\\\':
      return '\\';
    case '\\"':
      return '"';
    case '\\$':
      return '$';
    default:
      return seq;
  }
}
