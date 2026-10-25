import { type LangId, type SyntaxNode, loadQuery } from '../../parse.js';
import { SpanIndex } from '../../util/ranges.js';
import type { UrlPart } from '../../types.js';

export interface JsDef {
  /** Unique within the file: "Name", "Class.method", "obj.prop", "default", or "Name@line" for duplicates. */
  key: string;
  name: string;
  kind: 'function' | 'class' | 'method';
  line: number;
  parentKey?: string;
  jsx: boolean;
}

export interface JsImportBinding {
  local: string;
  /** 'default', '*', or the exported name. */
  imported: string;
}

export interface JsImport {
  source: string;
  line: number;
  bindings: JsImportBinding[];
}

export type JsExport = { kind: 'local'; local: string } | { kind: 'reexport'; source: string; imported: string };

/** What a module-level name refers to. */
export type TopBinding =
  | { kind: 'def'; key: string }
  /**
   * `const api = { get: () => ..., list, USERS: '/api/users' }`, or a compound component
   * `const Alert = Object.assign(AlertRoot, { Title: AlertTitle })` (callable = AlertRoot).
   * members: prop -> def key of an inline function; aliases: prop -> module-level name.
   */
  | { kind: 'object'; members: Map<string, string>; aliases: Map<string, string>; urls: Map<string, UrlPart[][]>; callable?: string }
  /** A module-level value that is not a syntactic definition (factory result, destructured export...). */
  | { kind: 'value' }
  /** String-ish constant usable in URLs. */
  | { kind: 'url'; parts: UrlPart[][] }
  /** `axios.create({ baseURL })`; base null when no baseURL is given. */
  | { kind: 'instance'; base: UrlPart[][] | null }
  | { kind: 'alias'; name: string };

export type Callee = { t: 'id'; name: string } | { t: 'member'; object: string; prop: string };

export interface JsCall {
  from: string;
  callee: Callee;
  line: number;
  jsx: boolean;
}

export type HttpClient = { t: 'fetch' } | { t: 'axios' } | { t: 'binding'; name: string };

export interface JsHttpCandidate {
  from: string;
  line: number;
  client: HttpClient;
  /** Upper-case method or null if unknown. */
  method: string | null;
  /** URL alternatives (ternaries expand into several); null when there is no URL argument. */
  url: UrlPart[][] | null;
  raw: string;
}

export interface JsFileInfo {
  rel: string;
  lang: LangId;
  useClient: boolean;
  defs: JsDef[];
  imports: JsImport[];
  exports: Map<string, JsExport>;
  starExports: string[];
  top: Map<string, TopBinding>;
  calls: JsCall[];
  http: JsHttpCandidate[];
  /** Syntax node of each definition, for line ranges when they are needed. */
  nodes: WeakMap<JsDef, SyntaxNode>;
}

const FUNCTION_TYPES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
/** HOCs whose first argument is the component itself. */
const WRAPPERS = new Set(['memo', 'forwardRef', 'observer', 'React.memo', 'React.forwardRef', 'withRouter', 'connect']);
const AXIOS_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const MAX_ALTERNATIVES = 4;

const line = (n: SyntaxNode) => n.startPosition.row + 1;
const short = (t: string) => {
  const one = t.replace(/\s+/g, ' ');
  return one.length > 120 ? one.slice(0, 117) + '...' : one;
};

/** Text of a JS string literal node (without quotes), or null. */
export function jsString(node: SyntaxNode | null | undefined): string | null {
  if (!node || node.type !== 'string') return null;
  let out = '';
  for (const c of node.namedChildren) {
    if (c.type === 'string_fragment') out += c.text;
    else if (c.type === 'escape_sequence') out += unescapeJs(c.text);
  }
  return out;
}

function unescapeJs(seq: string): string {
  const map: Record<string, string> = { '\\n': '\n', '\\t': '\t', '\\r': '\r', "\\'": "'", '\\"': '"', '\\\\': '\\', '\\/': '/', '\\`': '`', '\\$': '$' };
  return map[seq] ?? seq.slice(1);
}

function product(a: UrlPart[][], b: UrlPart[][]): UrlPart[][] {
  const out: UrlPart[][] = [];
  for (const x of a) for (const y of b) if (out.length < MAX_ALTERNATIVES) out.push([...x, ...y]);
  return out;
}

/** `process.env.X`, `process.env['X']`, `import.meta.env.X` -> X */
function envName(node: SyntaxNode): string | null {
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    if (!obj || !prop) return null;
    const objText = obj.text.replace(/\s+/g, '');
    if (objText === 'process.env' || objText === 'import.meta.env') return prop.text;
  } else if (node.type === 'subscript_expression') {
    const obj = node.childForFieldName('object');
    const idx = node.childForFieldName('index');
    const name = jsString(idx);
    if (obj && name && obj.text.replace(/\s+/g, '') === 'process.env') return name;
  }
  return null;
}

/**
 * Convert a URL expression into parts. Identifiers are resolved through
 * `lookupLocal` (function-scoped consts) here; module-level and imported names
 * stay as `ident`/`member` parts and are resolved later, across files.
 */
export function urlParts(node: SyntaxNode | null, lookupLocal: (name: string) => SyntaxNode | null = () => null, depth = 0): UrlPart[][] {
  if (!node) return [[{ t: 'expr', text: '' }]];
  if (depth > 8) return [[{ t: 'expr', text: short(node.text) }]];
  const rec = (n: SyntaxNode | null) => urlParts(n, lookupLocal, depth + 1);
  switch (node.type) {
    case 'string':
      return [[{ t: 'lit', v: jsString(node) ?? '' }]];
    case 'template_string': {
      let acc: UrlPart[][] = [[]];
      for (const c of node.namedChildren) {
        if (c.type === 'string_fragment') acc = product(acc, [[{ t: 'lit', v: c.text }]]);
        else if (c.type === 'escape_sequence') acc = product(acc, [[{ t: 'lit', v: unescapeJs(c.text) }]]);
        else if (c.type === 'template_substitution') acc = product(acc, rec(c.namedChildren[0] ?? null));
      }
      return acc;
    }
    case 'binary_expression': {
      const op = node.childForFieldName('operator')?.text ?? node.children.find((c) => !c.isNamed)?.text;
      if (op === '+') return product(rec(node.childForFieldName('left')), rec(node.childForFieldName('right')));
      if (op === '||' || op === '??') {
        // `process.env.X || "http://localhost:8000/api"`: the fallback tells which path the base URL carries.
        const left = rec(node.childForFieldName('left'));
        const right = node.childForFieldName('right');
        const basePath = right?.type === 'string' || right?.type === 'template_string' ? fallbackBasePath(jsString(right)) : null;
        if (!basePath) return left;
        return left.map((alt) => (alt[0]?.t === 'env' && alt[0].basePath === undefined ? [{ ...alt[0], basePath }, ...alt.slice(1)] : alt));
      }
      return [[{ t: 'expr', text: short(node.text) }]];
    }
    case 'ternary_expression': {
      const alts = [...rec(node.childForFieldName('consequence')), ...rec(node.childForFieldName('alternative'))];
      return alts.slice(0, MAX_ALTERNATIVES);
    }
    case 'parenthesized_expression':
    case 'as_expression':
    case 'satisfies_expression':
    case 'non_null_expression':
    case 'type_assertion':
      return rec(node.namedChildren[0] ?? null);
    case 'member_expression':
    case 'subscript_expression': {
      const env = envName(node);
      if (env) return [[{ t: 'env', name: env }]];
      const obj = node.childForFieldName('object');
      const prop = node.childForFieldName('property');
      if (node.type === 'member_expression' && obj?.type === 'identifier' && prop) return [[{ t: 'member', object: obj.text, prop: prop.text }]];
      return [[{ t: 'expr', text: short(node.text) }]];
    }
    case 'identifier': {
      const local = lookupLocal(node.text);
      if (local) return rec(local);
      return [[{ t: 'ident', name: node.text }]];
    }
    default:
      return [[{ t: 'expr', text: short(node.text) }]];
  }
}

/** Path of an absolute fallback URL ("http://127.0.0.1:8000/api/" -> "/api"), or null. */
function fallbackBasePath(url: string | null): string | null {
  const m = url ? /^https?:\/\/[^/?#]+(\/[^?#]*)?$/i.exec(url) : null;
  const path = m?.[1]?.replace(/\/+$/, '');
  return path ? path : null;
}

/** Const declarations inside a function body: name -> initializer (names declared twice are dropped). */
function localConsts(fn: SyntaxNode): Map<string, SyntaxNode | null> {
  const out = new Map<string, SyntaxNode | null>();
  for (const decl of fn.descendantsOfType('lexical_declaration')) {
    const isConst = decl.children.some((c) => c.type === 'const');
    for (const d of decl.namedChildren) {
      if (d.type !== 'variable_declarator') continue;
      const name = d.childForFieldName('name');
      if (name?.type !== 'identifier') continue;
      out.set(name.text, out.has(name.text) || !isConst ? null : d.childForFieldName('value'));
    }
  }
  return out;
}

/** `keep`: also record definition nodes for later passes (line ranges for the security lens). */
export function extractJs(rel: string, lang: LangId, root: SyntaxNode, keep = false): JsFileInfo {
  const info: JsFileInfo = {
    rel,
    lang,
    useClient: false,
    defs: [],
    imports: [],
    exports: new Map(),
    starExports: [],
    top: new Map(),
    calls: [],
    http: [],
    nodes: new WeakMap(),
  };
  const usedKeys = new Set<string>();
  const importLocals = new Set<string>();
  /** Names bound to the axios library itself. */
  const axiosLib = new Set<string>();
  /** Deferred body walks: run after all top-level bindings are known. */
  const bodies: { node: SyntaxNode; from: string; def: JsDef | null }[] = [];

  const addDef = (name: string, kind: JsDef['kind'], node: SyntaxNode, parentKey?: string): JsDef => {
    let key = parentKey ? `${parentKey}.${name}` : name;
    if (usedKeys.has(key)) key = `${key}@${line(node)}`;
    usedKeys.add(key);
    const def: JsDef = { key, name: parentKey ? `${parentKey}.${name}` : name, kind, line: line(node), jsx: false, ...(parentKey ? { parentKey } : {}) };
    if (keep) info.nodes.set(def, node);
    info.defs.push(def);
    return def;
  };

  const isAxiosCreate = (n: SyntaxNode | null): SyntaxNode | null => {
    if (n?.type !== 'call_expression') return null;
    const fn = n.childForFieldName('function');
    if (fn?.type !== 'member_expression') return null;
    const obj = fn.childForFieldName('object');
    if (obj?.type !== 'identifier' || fn.childForFieldName('property')?.text !== 'create') return null;
    return axiosLib.has(obj.text) || (obj.text === 'axios' && !info.top.has('axios')) ? n : null;
  };

  const objectProp = (obj: SyntaxNode | null, key: string): SyntaxNode | null | undefined => {
    if (obj?.type !== 'object') return undefined;
    for (const p of obj.namedChildren) {
      if (p.type === 'pair') {
        const k = p.childForFieldName('key');
        const kt = k?.type === 'string' ? jsString(k) : k?.text;
        if (kt === key) return p.childForFieldName('value');
      } else if (p.type === 'shorthand_property_identifier' && p.text === key) {
        return p; // identifier-like node
      }
    }
    return undefined;
  };

  const instanceBase = (createCall: SyntaxNode): UrlPart[][] | null => {
    const args = createCall.childForFieldName('arguments');
    const cfg = args?.namedChildren[0] ?? null;
    const base = objectProp(cfg, 'baseURL');
    if (base === undefined || base === null) return null;
    return urlParts(base.type === 'shorthand_property_identifier' ? null : base, () => null).map((alt) =>
      base.type === 'shorthand_property_identifier' ? [{ t: 'ident' as const, name: base.text }] : alt,
    );
  };

  /** Classify a module-level value: definition, object namespace, URL constant, axios instance... */
  const bindValue = (name: string, value: SyntaxNode | null, declNode: SyntaxNode, exportAs?: string) => {
    if (!value) return;
    if (exportAs) info.exports.set(exportAs, { kind: 'local', local: name });
    if (FUNCTION_TYPES.has(value.type)) {
      const def = addDef(name, 'function', declNode);
      info.top.set(name, { kind: 'def', key: def.key });
      bodies.push({ node: value, from: def.key, def });
      return;
    }
    if (value.type === 'class' || value.type === 'class_expression') {
      handleClass(value, name);
      return;
    }
    if (value.type === 'call_expression') {
      const create = isAxiosCreate(value);
      if (create) {
        info.top.set(name, { kind: 'instance', base: instanceBase(create) });
        return;
      }
      const fn = value.childForFieldName('function');
      const args = value.childForFieldName('arguments')?.namedChildren ?? [];
      // Compound component: const Alert = Object.assign(AlertRoot, { Title: AlertTitle })
      if (fn?.text === 'Object.assign' && args[0]?.type === 'identifier' && args[1]?.type === 'object') {
        const obj = objectBinding(name, args[1]);
        info.top.set(name, { ...obj, callable: args[0].text });
        return;
      }
      if (fn?.type === 'identifier' && fn.text === 'require') {
        const src = jsString(args[0]);
        if (src !== null) {
          info.imports.push({ source: src, line: line(value), bindings: [{ local: name, imported: 'default' }] });
          importLocals.add(name);
          if (src === 'axios') axiosLib.add(name);
          info.top.delete(name);
        }
        return;
      }
      if (fn && WRAPPERS.has(fn.text) && args[0]) {
        if (FUNCTION_TYPES.has(args[0].type)) {
          const def = addDef(name, 'function', declNode);
          info.top.set(name, { kind: 'def', key: def.key });
          bodies.push({ node: args[0], from: def.key, def });
          return;
        }
        if (args[0].type === 'identifier') {
          info.top.set(name, { kind: 'alias', name: args[0].text });
          return;
        }
      }
      // next/dynamic: const Map = dynamic(() => import('./Map'))
      if (fn?.text === 'dynamic' && args[0] && FUNCTION_TYPES.has(args[0].type)) {
        const imp = args[0].descendantsOfType('call_expression').find((c) => c.childForFieldName('function')?.type === 'import');
        const src = jsString(imp?.childForFieldName('arguments')?.namedChildren[0]);
        if (src !== null) {
          info.imports.push({ source: src, line: line(value), bindings: [{ local: name, imported: 'default' }] });
          importLocals.add(name);
          return;
        }
      }
      bodies.push({ node: value, from: '', def: null });
      return;
    }
    if (value.type === 'object') {
      info.top.set(name, objectBinding(name, value));
      return;
    }
    if (value.type === 'string' || value.type === 'template_string' || value.type === 'binary_expression' || value.type === 'member_expression' || value.type === 'subscript_expression' || value.type === 'ternary_expression') {
      info.top.set(name, { kind: 'url', parts: urlParts(value) });
      bodies.push({ node: value, from: '', def: null });
      return;
    }
    if (value.type === 'identifier') {
      info.top.set(name, { kind: 'alias', name: value.text });
      return;
    }
    info.top.set(name, { kind: 'value' });
    bodies.push({ node: value, from: '', def: null });
  };

  /** Members of an object literal used as a namespace of functions / URL constants. */
  const objectBinding = (name: string, value: SyntaxNode): Extract<TopBinding, { kind: 'object' }> => {
    const members = new Map<string, string>();
    const aliases = new Map<string, string>();
    const urls = new Map<string, UrlPart[][]>();
    for (const p of value.namedChildren) {
      if (p.type === 'shorthand_property_identifier') {
        aliases.set(p.text, p.text);
      } else if (p.type === 'method_definition') {
        const pname = p.childForFieldName('name')?.text;
        if (!pname) continue;
        const def = addDef(pname, 'method', p, name);
        members.set(pname, def.key);
        bodies.push({ node: p, from: def.key, def });
      } else if (p.type === 'pair') {
        const k = p.childForFieldName('key');
        const pname = k?.type === 'string' ? jsString(k) : k?.text;
        const v = p.childForFieldName('value');
        if (!pname || !v) continue;
        if (FUNCTION_TYPES.has(v.type)) {
          const def = addDef(pname, 'method', p, name);
          members.set(pname, def.key);
          bodies.push({ node: v, from: def.key, def });
        } else if (v.type === 'identifier') {
          aliases.set(pname, v.text);
        } else if (v.type === 'string' || v.type === 'template_string' || v.type === 'binary_expression') {
          urls.set(pname, urlParts(v));
        } else bodies.push({ node: v, from: '', def: null });
      }
    }
    return { kind: 'object', members, aliases, urls };
  };

  const handleClass = (node: SyntaxNode, fallbackName?: string, exportAs?: string) => {
    const name = node.childForFieldName('name')?.text ?? fallbackName ?? 'default';
    const def = addDef(name, 'class', node);
    info.top.set(name, { kind: 'def', key: def.key });
    if (exportAs) info.exports.set(exportAs, { kind: 'local', local: name });
    const body = node.childForFieldName('body');
    for (const m of body?.namedChildren ?? []) {
      if (m.type === 'method_definition') {
        const mName = m.childForFieldName('name')?.text;
        if (!mName) continue;
        const md = addDef(mName, 'method', m, def.key);
        bodies.push({ node: m, from: md.key, def: md });
      } else if (m.type === 'public_field_definition' || m.type === 'field_definition') {
        const v = m.childForFieldName('value');
        const mName = (m.childForFieldName('name') ?? m.childForFieldName('property'))?.text;
        if (v && mName && FUNCTION_TYPES.has(v.type)) {
          const md = addDef(mName, 'method', m, def.key);
          bodies.push({ node: v, from: md.key, def: md });
        } else if (v) bodies.push({ node: v, from: def.key, def });
      }
    }
  };

  const handleFunctionDecl = (node: SyntaxNode, exportAs?: string, fallbackName = 'default') => {
    const name = node.childForFieldName('name')?.text ?? fallbackName;
    const def = addDef(name, 'function', node);
    info.top.set(name, { kind: 'def', key: def.key });
    if (exportAs) info.exports.set(exportAs, { kind: 'local', local: name });
    bodies.push({ node, from: def.key, def });
  };

  const handleDeclaration = (decl: SyntaxNode, exported: boolean) => {
    switch (decl.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
        return handleFunctionDecl(decl, exported ? decl.childForFieldName('name')?.text : undefined);
      case 'class_declaration':
      case 'abstract_class_declaration':
        return handleClass(decl, undefined, exported ? decl.childForFieldName('name')?.text : undefined);
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const d of decl.namedChildren) {
          if (d.type !== 'variable_declarator') continue;
          const nameNode = d.childForFieldName('name');
          const value = d.childForFieldName('value');
          if (nameNode?.type === 'identifier') bindValue(nameNode.text, value, d, exported ? nameNode.text : undefined);
          else if (nameNode?.type === 'object_pattern' && value) {
            // const { a, b } = require('./x')
            const fn = value.type === 'call_expression' ? value.childForFieldName('function') : null;
            const src = fn?.text === 'require' ? jsString(value.childForFieldName('arguments')?.namedChildren[0]) : null;
            if (src !== null) {
              const bindings: JsImportBinding[] = [];
              for (const p of nameNode.namedChildren) {
                if (p.type === 'shorthand_property_identifier_pattern') bindings.push({ local: p.text, imported: p.text });
                else if (p.type === 'pair_pattern') {
                  const k = p.childForFieldName('key')?.text;
                  const v = p.childForFieldName('value');
                  if (k && v?.type === 'identifier') bindings.push({ local: v.text, imported: k });
                }
              }
              for (const b of bindings) importLocals.add(b.local);
              info.imports.push({ source: src, line: line(d), bindings });
            } else {
              // const { a, b } = makeThings(): opaque module-level values.
              for (const id of nameNode.descendantsOfType(['shorthand_property_identifier_pattern', 'identifier'])) {
                info.top.set(id.text, { kind: 'value' });
                if (exported) info.exports.set(id.text, { kind: 'local', local: id.text });
              }
              bodies.push({ node: value, from: '', def: null });
            }
          } else if (nameNode?.type === 'array_pattern' && value) {
            // export const [tool, handler] = defineTool(...): opaque module-level values.
            for (const id of nameNode.descendantsOfType('identifier')) {
              info.top.set(id.text, { kind: 'value' });
              if (exported) info.exports.set(id.text, { kind: 'local', local: id.text });
            }
            bodies.push({ node: value, from: '', def: null });
          } else if (value) bodies.push({ node: value, from: '', def: null });
        }
        return;
      default:
        bodies.push({ node: decl, from: '', def: null });
    }
  };

  const handleImport = (node: SyntaxNode) => {
    const source = jsString(node.childForFieldName('source'));
    if (source === null) return;
    const bindings: JsImportBinding[] = [];
    const clause = node.namedChildren.find((c) => c.type === 'import_clause');
    for (const c of clause?.namedChildren ?? []) {
      if (c.type === 'identifier') bindings.push({ local: c.text, imported: 'default' });
      else if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((x) => x.type === 'identifier');
        if (id) bindings.push({ local: id.text, imported: '*' });
      } else if (c.type === 'named_imports') {
        for (const s of c.namedChildren) {
          if (s.type !== 'import_specifier') continue;
          const nameNode = s.childForFieldName('name');
          const alias = s.childForFieldName('alias');
          if (!nameNode) continue;
          const imported = nameNode.type === 'string' ? (jsString(nameNode) ?? nameNode.text) : nameNode.text;
          bindings.push({ local: (alias ?? nameNode).text, imported });
        }
      }
    }
    for (const b of bindings) {
      importLocals.add(b.local);
      if (source === 'axios' && (b.imported === 'default' || b.imported === '*')) axiosLib.add(b.local);
    }
    info.imports.push({ source, line: line(node), bindings });
  };

  const handleExport = (node: SyntaxNode) => {
    const source = jsString(node.childForFieldName('source'));
    const isDefault = node.children.some((c) => c.type === 'default');
    const decl = node.childForFieldName('declaration');
    const value = node.childForFieldName('value');
    if (source !== null) {
      const clause = node.namedChildren.find((c) => c.type === 'export_clause');
      const nsExport = node.namedChildren.find((c) => c.type === 'namespace_export');
      if (clause) {
        for (const s of clause.namedChildren) {
          if (s.type !== 'export_specifier') continue;
          const name = s.childForFieldName('name')?.text;
          const alias = s.childForFieldName('alias')?.text;
          if (name) info.exports.set(alias ?? name, { kind: 'reexport', source, imported: name });
        }
      } else if (nsExport) {
        const id = nsExport.namedChildren[0];
        if (id) info.exports.set(id.text, { kind: 'reexport', source, imported: '*' });
      } else info.starExports.push(source);
      info.imports.push({ source, line: line(node), bindings: [] });
      return;
    }
    if (decl) {
      if (isDefault && (decl.type === 'function_declaration' || decl.type === 'generator_function_declaration')) {
        return handleFunctionDecl(decl, 'default');
      }
      if (isDefault && decl.type === 'class_declaration') return handleClass(decl, 'default', 'default');
      return handleDeclaration(decl, true);
    }
    if (isDefault && value) {
      if (value.type === 'identifier') {
        info.exports.set('default', { kind: 'local', local: value.text });
        return;
      }
      if (FUNCTION_TYPES.has(value.type) && value.type !== 'arrow_function' && value.childForFieldName('name')) {
        return handleFunctionDecl(value, 'default');
      }
      if (value.type === 'class' || value.type === 'class_expression') return handleClass(value, 'default', 'default');
      bindValue('default', value, value, 'default');
      return;
    }
    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    for (const s of clause?.namedChildren ?? []) {
      if (s.type !== 'export_specifier') continue;
      const name = s.childForFieldName('name')?.text;
      const alias = s.childForFieldName('alias')?.text;
      if (name) info.exports.set(alias ?? name, { kind: 'local', local: name });
    }
  };

  /** module.exports = ..., exports.x = ..., module.exports.x = ... */
  const handleCommonJsExport = (assign: SyntaxNode): boolean => {
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (!left || !right || left.type !== 'member_expression') return false;
    const lt = left.text.replace(/\s+/g, '');
    if (lt === 'module.exports') {
      if (right.type === 'identifier') info.exports.set('default', { kind: 'local', local: right.text });
      else if (right.type === 'object') {
        for (const p of right.namedChildren) {
          if (p.type === 'shorthand_property_identifier') info.exports.set(p.text, { kind: 'local', local: p.text });
          else if (p.type === 'pair') {
            const k = p.childForFieldName('key')?.text;
            const v = p.childForFieldName('value');
            if (!k || !v) continue;
            if (v.type === 'identifier') info.exports.set(k, { kind: 'local', local: v.text });
            else bindValue(k, v, p, k);
          }
        }
      } else bindValue('default', right, assign, 'default');
      return true;
    }
    const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(lt);
    if (m) {
      if (right.type === 'identifier') info.exports.set(m[1], { kind: 'local', local: right.text });
      else bindValue(m[1], right, assign, m[1]);
      return true;
    }
    return false;
  };

  // --- Pass 1: module-level declarations -----------------------------------
  const statements = root.namedChildren;
  let inPrologue = true; // directives ("use client") must precede any other statement
  for (const st of statements) {
    if (st.type !== 'comment' && !(st.type === 'expression_statement' && st.namedChildren[0]?.type === 'string')) inPrologue = false;
    switch (st.type) {
      case 'import_statement':
        handleImport(st);
        break;
      case 'export_statement':
        handleExport(st);
        break;
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'lexical_declaration':
      case 'variable_declaration':
        handleDeclaration(st, false);
        break;
      case 'expression_statement': {
        const e = st.namedChildren[0];
        if (inPrologue && e?.type === 'string') {
          if (jsString(e) === 'use client') info.useClient = true;
          break;
        }
        if (e?.type === 'assignment_expression' && handleCommonJsExport(e)) break;
        bodies.push({ node: st, from: '', def: null });
        break;
      }
      case 'comment':
        break;
      default:
        bodies.push({ node: st, from: '', def: null });
    }
  }

  // --- Pass 2: calls, JSX usages and HTTP calls ------------------------------
  // A Tree-sitter query finds the call/JSX nodes natively; each one is attributed
  // to the innermost body (top-level definition or module statement) containing it.
  interface BodyCtx {
    from: string;
    def: JsDef | null;
    node: SyntaxNode | null;
    start: number;
    end: number;
    shadow?: Set<string>;
    consts?: Map<string, SyntaxNode | null>;
  }
  const bodyIndex = new SpanIndex<BodyCtx>(bodies.map((b) => ({ from: b.from, def: b.def, node: b.node, start: b.node.startIndex, end: b.node.endIndex })));
  const moduleCtx: BodyCtx = { from: '', def: null, node: null, start: 0, end: Infinity };
  const ctxAt = (pos: number): BodyCtx => bodyIndex.innermost(pos) ?? moduleCtx;
  /**
   * Names declared inside the body (params, variables, inner functions), found with a
   * query on the body node; computed only when a call could refer to a module binding.
   * (Query byte-range options are not used: they count bytes, node indexes count UTF-16 units.)
   */
  const localsQuery = loadQuery(lang, import.meta.url, lang === 'js' ? 'queries/locals-js.scm' : 'queries/locals-ts.scm');
  const shadowOf = (ctx: BodyCtx): Set<string> => {
    if (ctx.shadow) return ctx.shadow;
    ctx.shadow = new Set<string>();
    if (ctx.def && ctx.node && ctx.node.type !== 'class_declaration') {
      for (const c of localsQuery.captures(ctx.node)) ctx.shadow.add(c.node.text);
    }
    return ctx.shadow;
  };
  const lookupLocal = (ctx: BodyCtx) => (name: string): SyntaxNode | null => {
    if (!ctx.def || !ctx.node) return null;
    ctx.consts ??= localConsts(ctx.node);
    return ctx.consts.get(name) ?? null;
  };
  const isProjectBinding = (name: string) => info.top.has(name) || importLocals.has(name);
  const isAxiosLib = (name: string, ctx: BodyCtx) =>
    (axiosLib.has(name) || (name === 'axios' && !info.top.has('axios') && !importLocals.has('axios'))) && !shadowOf(ctx).has(name);

  /** Parts naming a local (non-const) variable or parameter are dynamic, not module constants. */
  const unshadow = (alts: UrlPart[][], ctx: BodyCtx): UrlPart[][] =>
    alts.map((alt) =>
      alt.map((p): UrlPart =>
        (p.t === 'ident' && shadowOf(ctx).has(p.name)) || (p.t === 'member' && shadowOf(ctx).has(p.object))
          ? { t: 'expr', text: p.t === 'ident' ? p.name : `${p.object}.${p.prop}` }
          : p,
      ),
    );
  const urlArg = (a: SyntaxNode | undefined, ctx: BodyCtx): UrlPart[][] | null => (a ? unshadow(urlParts(a, lookupLocal(ctx)), ctx) : null);

  /** fetch(url, init): method from a literal init object; GET when absent. */
  const fetchMethod = (init: SyntaxNode | undefined): string | null => {
    if (!init) return 'GET';
    if (init.type !== 'object') return null;
    const m = objectProp(init, 'method');
    if (m === undefined) return init.namedChildren.some((c) => c.type === 'spread_element') ? null : 'GET';
    const s = m ? jsString(m) : null;
    return s ? s.toUpperCase() : null;
  };

  /** axios(config) / axios(url, config) / instance.request(config). */
  const configCall = (args: SyntaxNode[], ctx: BodyCtx): { method: string | null; url: UrlPart[][] | null } => {
    const first = args[0];
    if (!first) return { method: null, url: null };
    if (first.type === 'object') {
      const u = objectProp(first, 'url');
      const m = objectProp(first, 'method');
      const method = m === undefined ? (first.namedChildren.some((c) => c.type === 'spread_element') ? null : 'GET') : m ? (jsString(m)?.toUpperCase() ?? null) : null;
      return { method, url: u ? urlArg(u, ctx) : null };
    }
    const cfg = args[1];
    let method: string | null = 'GET';
    if (cfg?.type === 'object') {
      const m = objectProp(cfg, 'method');
      if (m !== undefined) method = m ? (jsString(m)?.toUpperCase() ?? null) : null;
    } else if (cfg) method = null;
    return { method, url: urlArg(first, ctx) };
  };

  const handleJsx = (n: SyntaxNode, ctx: BodyCtx) => {
    if (ctx.def) ctx.def.jsx = true;
    const name = n.childForFieldName('name');
    if (!name) return; // fragment <>
    if (name.type === 'identifier') {
      if (/^[A-Z]/.test(name.text) && isProjectBinding(name.text) && !shadowOf(ctx).has(name.text)) {
        info.calls.push({ from: ctx.from, callee: { t: 'id', name: name.text }, line: line(n), jsx: true });
      }
    } else if (name.type === 'member_expression') {
      const obj = name.childForFieldName('object');
      const prop = name.childForFieldName('property');
      if (obj?.type === 'identifier' && prop && isProjectBinding(obj.text) && !shadowOf(ctx).has(obj.text)) {
        info.calls.push({ from: ctx.from, callee: { t: 'member', object: obj.text, prop: prop.text }, line: line(n), jsx: true });
      }
    }
  };

  /** Callee was captured by the query: an identifier, the object of `obj.prop(...)`, or `import`. */
  const handleCall = (capture: string, callee: SyntaxNode, ctx: BodyCtx) => {
    const from = ctx.from;
    if (capture === 'callee.import') {
      // Dynamic import('./x'): a file-level import edge (unless next/dynamic already recorded it with a binding).
      const src = jsString(callee.parent?.childForFieldName('arguments')?.namedChildren[0]);
      const at = line(callee);
      if (src !== null && !info.imports.some((i) => i.source === src && i.line === at)) info.imports.push({ source: src, line: at, bindings: [] });
      return;
    }
    const name = callee.text;
    if (capture === 'callee.id') {
      const isFetch = name === 'fetch' && !isProjectBinding(name);
      // Cheap filter first: most calls are to locals and globals we never resolve.
      if (!isFetch && !isProjectBinding(name) && !axiosLib.has(name) && name !== 'axios') return;
      const n = callee.parent as SyntaxNode;
      const args = n.childForFieldName('arguments')?.namedChildren ?? [];
      if (isFetch) {
        if (shadowOf(ctx).has(name)) return;
        info.http.push({ from, line: line(n), client: { t: 'fetch' }, method: fetchMethod(args[1]), url: urlArg(args[0], ctx), raw: short(n.text) });
        return;
      }
      if (isAxiosLib(name, ctx)) {
        info.http.push({ from, line: line(n), client: { t: 'axios' }, ...configCall(args, ctx), raw: short(n.text) });
        return;
      }
      if (!isProjectBinding(name) || shadowOf(ctx).has(name)) return;
      const top = info.top.get(name);
      if (top?.kind === 'instance' || importLocals.has(name)) {
        // Possibly an axios instance called directly: api({ url, method }); dropped at resolve time otherwise.
        info.http.push({ from, line: line(n), client: { t: 'binding', name }, ...configCall(args, ctx), raw: short(n.text) });
      }
      if (top?.kind !== 'instance') info.calls.push({ from, callee: { t: 'id', name }, line: line(n), jsx: false });
      return;
    }
    // obj.prop(...)
    const isGlobalFetch = name === 'window' || name === 'globalThis' || name === 'self';
    if (!isGlobalFetch && !isProjectBinding(name) && !axiosLib.has(name) && name !== 'axios') return;
    const member = callee.parent as SyntaxNode;
    const n = member.parent as SyntaxNode;
    const prop = member.childForFieldName('property')?.text;
    if (!prop) return;
    const args = () => n.childForFieldName('arguments')?.namedChildren ?? [];
    if (isGlobalFetch) {
      if (prop !== 'fetch') return;
      const a = args();
      info.http.push({ from, line: line(n), client: { t: 'fetch' }, method: fetchMethod(a[1]), url: urlArg(a[0], ctx), raw: short(n.text) });
      return;
    }
    const lower = prop.toLowerCase();
    if (isAxiosLib(name, ctx)) {
      const a = args();
      if (AXIOS_METHODS.has(lower)) info.http.push({ from, line: line(n), client: { t: 'axios' }, method: lower.toUpperCase(), url: urlArg(a[0], ctx), raw: short(n.text) });
      else if (lower === 'request') info.http.push({ from, line: line(n), client: { t: 'axios' }, ...configCall(a, ctx), raw: short(n.text) });
      return;
    }
    if (!isProjectBinding(name) || shadowOf(ctx).has(name)) return;
    const top = info.top.get(name);
    if (AXIOS_METHODS.has(lower) || lower === 'request') {
      if (top?.kind === 'instance' || importLocals.has(name)) {
        const a = args();
        const http = lower === 'request' ? configCall(a, ctx) : { method: lower.toUpperCase(), url: urlArg(a[0], ctx) };
        info.http.push({ from, line: line(n), client: { t: 'binding', name }, ...http, raw: short(n.text) });
      }
      if (top?.kind === 'instance') return;
    }
    info.calls.push({ from, callee: { t: 'member', object: name, prop }, line: line(n), jsx: false });
  };

  const query = loadQuery(lang, import.meta.url, ...(lang === 'ts' ? ['queries/calls.scm'] : ['queries/calls.scm', 'queries/jsx.scm']));
  for (const cap of query.captures(root)) {
    const ctx = ctxAt(cap.node.startIndex);
    if (cap.name === 'jsx') handleJsx(cap.node, ctx);
    else handleCall(cap.name, cap.node, ctx);
  }

  return info;
}
