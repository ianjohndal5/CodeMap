import type { PhpClass } from '../lang/php/extract.js';
import type { LaravelAdapter } from '../lang/php/index.js';
import { collectFileScope, type PhpScope } from '../lang/php/names.js';
import type { SyntaxNode } from '../parse.js';
import type { ClassIndex } from './resolver.js';

const CLASS_TYPES = ['class_declaration', 'trait_declaration', 'interface_declaration', 'enum_declaration'];

/** Syntax-tree lookups over the trees the Laravel adapter already parsed (nothing is re-parsed). */
export class PhpIndex implements ClassIndex {
  private scopes = new Map<string, PhpScope>();
  private classNodes = new Map<PhpClass, SyntaxNode | null>();
  /** Methods declared on each class, by lower-cased name (built once: reading a class body is costly). */
  private methods = new Map<PhpClass, Map<string, SyntaxNode>>();
  private infos: Map<string, (pos: number) => PhpScope>;

  constructor(private laravel: LaravelAdapter) {
    this.infos = new Map(laravel.infos.flatMap((i) => (i.scopeAt ? [[i.rel, i.scopeAt] as const] : [])));
  }

  findClass(fqn: string): PhpClass | null {
    return this.laravel.findClass(fqn);
  }

  fileOf(cls: PhpClass): string | null {
    return this.laravel.classFiles.get(cls) ?? null;
  }

  /** Source text of a scanned file ('' when unknown). */
  source(rel: string): string {
    return this.laravel.parsed.get(rel)?.source ?? '';
  }

  tree(rel: string): SyntaxNode | null {
    return this.laravel.parsed.get(rel)?.tree.rootNode ?? null;
  }

  /** Scope at a position: reuses what extraction computed, else reads the file's top-level imports. */
  scope(rel: string, pos = 0): PhpScope {
    const at = this.infos.get(rel);
    if (at) return at(pos);
    let s = this.scopes.get(rel);
    if (!s) {
      const root = this.tree(rel);
      s = root ? collectFileScope(root) : collectFileScope(this.laravel.bootstrap!);
      this.scopes.set(rel, s);
    }
    return s;
  }

  classNode(cls: PhpClass): SyntaxNode | null {
    if (this.classNodes.has(cls)) return this.classNodes.get(cls)!;
    const rel = this.fileOf(cls);
    const root = rel ? this.tree(rel) : null;
    let found: SyntaxNode | null = null;
    if (root) {
      // Classes sit at the top level or directly inside a namespace block; no need to walk whole files.
      const top = root.namedChildren.flatMap((n) => (n.type === 'namespace_definition' ? (n.childForFieldName('body')?.namedChildren ?? []) : [n]));
      let candidates = top.filter((n) => CLASS_TYPES.includes(n.type) && n.childForFieldName('name')?.text === cls.name);
      if (!candidates.length) candidates = root.descendantsOfType(CLASS_TYPES).filter((n) => n.childForFieldName('name')?.text === cls.name);
      found = candidates.find((n) => n.startPosition.row + 1 === cls.line) ?? candidates[0] ?? null;
    }
    this.classNodes.set(cls, found);
    return found;
  }

  /** A method declared on the class itself. */
  methodNode(cls: PhpClass, name: string): SyntaxNode | null {
    let index = this.methods.get(cls);
    if (!index) {
      index = new Map();
      for (const m of this.classNode(cls)?.childForFieldName('body')?.namedChildren ?? []) {
        if (m.type !== 'method_declaration') continue;
        const key = m.childForFieldName('name')?.text.toLowerCase();
        if (key && !index.has(key)) index.set(key, m);
      }
      this.methods.set(cls, index);
    }
    return index.get(name.toLowerCase()) ?? null;
  }

  methodBody(cls: PhpClass, name: string): { node: SyntaxNode; file: string } | null {
    const node = this.methodNode(cls, name);
    const file = this.fileOf(cls);
    return node && file ? { node, file } : null;
  }

  /** A method on the class or the nearest project ancestor that declares it. */
  findMethod(cls: PhpClass, name: string): { cls: PhpClass; node: SyntaxNode; file: string; inherited: boolean } | null {
    let cur: PhpClass | null = cls;
    for (let depth = 0; cur && depth < 6; depth++) {
      const node = this.methodNode(cur, name);
      const file = this.fileOf(cur);
      if (node && file) return { cls: cur, node, file, inherited: depth > 0 };
      cur = cur.extends[0] ? this.findClass(cur.extends[0]) : null;
    }
    return null;
  }

  /** True when the class or a project ancestor extends/implements `fqnLower`. Unresolvable ancestors give false. */
  isA(cls: PhpClass, fqnLower: string, via: 'extends' | 'implements' = 'extends'): boolean {
    let cur: PhpClass | null = cls;
    for (let depth = 0; cur && depth < 8; depth++) {
      const list = via === 'extends' ? cur.extends : [...cur.implements, ...cur.extends];
      if (list.some((x) => x.toLowerCase() === fqnLower)) return true;
      cur = cur.extends[0] ? this.findClass(cur.extends[0]) : null;
    }
    return false;
  }
}

/** Enclosing node of one of the given types, stopping at `limit`. */
export function enclosing(node: SyntaxNode, types: Set<string>, limit: SyntaxNode): SyntaxNode | null {
  for (let p = node.parent; p && p.id !== limit.id; p = p.parent) if (types.has(p.type)) return p;
  return null;
}

export const FUNCTION_TYPES = new Set(['anonymous_function', 'arrow_function', 'anonymous_function_creation_expression']);
export const CONDITIONAL_TYPES = new Set([
  'if_statement',
  'else_clause',
  'else_if_clause',
  'switch_statement',
  'conditional_expression',
  'match_expression',
  'foreach_statement',
  'for_statement',
  'while_statement',
  'do_statement',
  'binary_expression',
]);

export const firstLine = (n: SyntaxNode, max = 90) => {
  const t = n.text.split('\n')[0].trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
