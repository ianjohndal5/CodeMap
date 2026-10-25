import type { SyntaxNode } from '../parse.js';
import { collectFileScope, phpString, type PhpScope } from '../lang/php/names.js';
import { middlewareNames } from '../lang/php/routes.js';
import { DEFAULT_GLOBAL, DEFAULT_GROUPS } from './catalog.js';

/** One middleware entry in a group or the global stack. */
export interface MwRef {
  name: string | null;
  text: string;
  source: string;
}

/** Aliases, groups and global middleware as the project declares them. */
export interface Registry {
  aliases: Map<string, { target: string; source: string }>;
  groups: Map<string, { members: MwRef[]; source: string }>;
  global: MwRef[];
  /** Laravel <= 10 style app/Http/Kernel.php was found. */
  hasKernel: boolean;
}

const at = (rel: string, n: SyntaxNode) => `${rel}:${n.startPosition.row + 1}`;

/** Call arguments with their PHP 8 names (`append: [...]`). */
export function namedArgs(call: SyntaxNode): { name: string | null; value: SyntaxNode }[] {
  const args = call.childForFieldName('arguments') ?? call.namedChildren.find((c) => c.type === 'arguments');
  if (!args) return [];
  return args.namedChildren
    .filter((a) => a.type === 'argument')
    .map((a) => ({ name: a.childForFieldName('name')?.text ?? null, value: a.namedChildren[a.namedChildren.length - 1] }));
}

/** `['key' => value, ...]` entries with literal keys. */
function keyed(node: SyntaxNode | undefined): [string, SyntaxNode][] {
  const out: [string, SyntaxNode][] = [];
  if (!node || node.type !== 'array_creation_expression') return out;
  for (const el of node.namedChildren) {
    if (el.type !== 'array_element_initializer' || el.namedChildren.length !== 2) continue;
    const key = phpString(el.namedChildren[0]);
    if (key !== null) out.push([key, el.namedChildren[1]]);
  }
  return out;
}

function refs(node: SyntaxNode | undefined, scope: PhpScope, source: string): MwRef[] {
  return middlewareNames(node, scope).map((m) => ({ ...m, source }));
}

/** Group edits recorded in source order and applied in Laravel's order (replace, remove, append, prepend). */
class GroupEdits {
  replaced = new Map<string, MwRef[]>();
  replacements: { group: string; search: string; replace: MwRef }[] = [];
  removals: { group: string; name: string }[] = [];
  appends: { group: string; refs: MwRef[] }[] = [];
  prepends: { group: string; refs: MwRef[] }[] = [];
  sources = new Map<string, string>();

  touch(group: string, source: string): void {
    if (!this.sources.has(group)) this.sources.set(group, source);
  }

  apply(groups: Registry['groups']): void {
    for (const [g, members] of this.replaced) groups.set(g, { members, source: this.sources.get(g) ?? '' });
    for (const r of this.replacements) {
      const g = groups.get(r.group);
      if (g) g.members = g.members.map((m) => (m.name === r.search ? r.replace : m));
    }
    for (const r of this.removals) {
      const g = groups.get(r.group);
      if (g) g.members = g.members.filter((m) => m.name !== r.name);
    }
    const ensure = (name: string) => {
      let g = groups.get(name);
      if (!g) groups.set(name, (g = { members: [], source: this.sources.get(name) ?? '' }));
      return g;
    };
    for (const a of this.appends) ensure(a.group).members.push(...a.refs);
    // Laravel merges all prepends for a group in registration order, then puts them first.
    const pre = new Map<string, MwRef[]>();
    for (const p of this.prepends) pre.set(p.group, [...(pre.get(p.group) ?? []), ...p.refs]);
    for (const [group, list] of pre) {
      const g = ensure(group);
      g.members = [...list, ...g.members];
    }
  }
}

function kernelProperties(rel: string, root: SyntaxNode, scope: PhpScope, reg: Registry): void {
  for (const prop of root.descendantsOfType('property_element')) {
    const name = prop.namedChildren.find((c) => c.type === 'variable_name')?.text;
    const value = prop.childForFieldName('default_value') ?? prop.namedChildren.find((c) => c.type === 'array_creation_expression');
    if (!name || !value) continue;
    if (name === '$middleware') reg.global = refs(value, scope, at(rel, prop));
    else if (name === '$middlewareGroups') {
      reg.groups = new Map();
      for (const [g, members] of keyed(value)) reg.groups.set(g, { members: refs(members, scope, at(rel, members)), source: at(rel, members) });
    } else if (name === '$middlewareAliases' || name === '$routeMiddleware') {
      for (const [alias, target] of keyed(value)) {
        const t = middlewareNames(target, scope)[0]?.name;
        if (t) reg.aliases.set(alias, { target: t, source: at(rel, target) });
      }
    }
  }
}

/** The `function (Middleware $middleware) { ... }` passed to `->withMiddleware()` in bootstrap/app.php. */
function bootstrapMiddleware(root: SyntaxNode, scope: PhpScope, reg: Registry, edits: GroupEdits): void {
  const rel = 'bootstrap/app.php';
  for (const call of root.descendantsOfType('member_call_expression')) {
    if (call.childForFieldName('name')?.text !== 'withMiddleware') continue;
    const fn = namedArgs(call)[0]?.value;
    if (!fn || (fn.type !== 'anonymous_function' && fn.type !== 'arrow_function')) continue;
    const param = fn.childForFieldName('parameters')?.namedChildren[0]?.childForFieldName('name')?.text;
    const body = fn.childForFieldName('body');
    if (!param || !body) continue;
    let global: MwRef[] | null = null;
    const prepend: MwRef[] = [];
    const append: MwRef[] = [];
    const remove: string[] = [];
    for (const c of body.descendantsOfType('member_call_expression')) {
      let obj = c.childForFieldName('object');
      while (obj?.type === 'member_call_expression') obj = obj.childForFieldName('object');
      if (obj?.type !== 'variable_name' || obj.text !== '$' + param.replace(/^\$/, '')) continue;
      const method = c.childForFieldName('name')?.text ?? '';
      const args = namedArgs(c);
      const src = at(rel, c);
      const arg = (n: string, i: number) => args.find((a) => a.name === n)?.value ?? (args[i] && !args[i].name ? args[i].value : undefined);
      const groupName = () => phpString(arg('group', 0));
      switch (method) {
        case 'alias':
          for (const [alias, target] of keyed(arg('aliases', 0))) {
            const t = middlewareNames(target, scope)[0]?.name;
            if (t) reg.aliases.set(alias, { target: t, source: at(rel, target) });
          }
          break;
        case 'group': {
          const g = groupName();
          if (g === null) break;
          edits.replaced.set(g, refs(arg('middleware', 1), scope, src));
          edits.sources.set(g, src);
          break;
        }
        case 'appendToGroup':
        case 'prependToGroup': {
          const g = groupName();
          if (g === null) break;
          edits.touch(g, src);
          (method === 'appendToGroup' ? edits.appends : edits.prepends).push({ group: g, refs: refs(arg('middleware', 1), scope, src) });
          break;
        }
        case 'removeFromGroup': {
          const g = groupName();
          if (g === null) break;
          for (const r of refs(arg('middleware', 1), scope, src)) if (r.name) edits.removals.push({ group: g, name: r.name });
          break;
        }
        case 'replaceInGroup': {
          const g = groupName();
          const search = middlewareNames(arg('search', 1), scope)[0]?.name;
          const replace = refs(arg('replace', 2), scope, src)[0];
          if (g !== null && search && replace) edits.replacements.push({ group: g, search, replace });
          break;
        }
        case 'web':
        case 'api': {
          edits.touch(method, src);
          const a = arg('append', -1);
          const p = arg('prepend', -1);
          const r = arg('remove', -1);
          if (a) edits.appends.push({ group: method, refs: refs(a, scope, src) });
          if (p) edits.prepends.push({ group: method, refs: refs(p, scope, src) });
          if (r) for (const x of refs(r, scope, src)) if (x.name) edits.removals.push({ group: method, name: x.name });
          for (const [search, rep] of keyed(arg('replace', -1))) {
            const replace = refs(rep, scope, src)[0];
            if (replace) edits.replacements.push({ group: method, search, replace });
          }
          break;
        }
        case 'statefulApi':
          edits.prepends.push({ group: 'api', refs: [{ name: 'Laravel\\Sanctum\\Http\\Middleware\\EnsureFrontendRequestsAreStateful', text: 'statefulApi()', source: src }] });
          break;
        case 'throttleApi': {
          const limiter = phpString(arg('limiter', 0)) ?? 'api';
          edits.prepends.push({ group: 'api', refs: [{ name: `throttle:${limiter}`, text: 'throttleApi()', source: src }] });
          break;
        }
        case 'authenticateSessions':
          edits.appends.push({ group: 'web', refs: [{ name: 'Illuminate\\Session\\Middleware\\AuthenticateSession', text: 'authenticateSessions()', source: src }] });
          break;
        case 'use':
          global = refs(arg('middleware', 0), scope, src);
          break;
        case 'append':
          append.push(...refs(arg('middleware', 0), scope, src));
          break;
        case 'prepend':
          prepend.push(...refs(arg('middleware', 0), scope, src));
          break;
        case 'remove':
          for (const r of refs(arg('middleware', 0), scope, src)) if (r.name) remove.push(r.name);
          break;
        // redirectGuestsTo, validateCsrfTokens, encryptCookies, trustProxies, priority...: no access effect
      }
    }
    const base = global ?? reg.global;
    reg.global = [...prepend, ...base, ...append].filter((m) => !m.name || !remove.includes(m.name));
  }
}

/** `$router->aliasMiddleware('x', X::class)`, `->middlewareGroup()`, `->pushMiddlewareToGroup()` in providers. */
function providerCalls(rel: string, root: SyntaxNode, scope: PhpScope, reg: Registry, edits: GroupEdits): void {
  for (const c of root.descendantsOfType(['member_call_expression', 'scoped_call_expression'])) {
    const method = c.childForFieldName('name')?.text;
    if (method !== 'aliasMiddleware' && method !== 'middlewareGroup' && method !== 'pushMiddlewareToGroup' && method !== 'prependMiddlewareToGroup') continue;
    const args = namedArgs(c);
    const name = phpString(args[0]?.value);
    if (name === null || !args[1]) continue;
    const src = at(rel, c);
    if (method === 'aliasMiddleware') {
      const t = middlewareNames(args[1].value, scope)[0]?.name;
      if (t) reg.aliases.set(name, { target: t, source: src });
    } else if (method === 'middlewareGroup') {
      edits.replaced.set(name, refs(args[1].value, scope, src));
      edits.sources.set(name, src);
    } else {
      edits.touch(name, src);
      (method === 'pushMiddlewareToGroup' ? edits.appends : edits.prepends).push({ group: name, refs: refs(args[1].value, scope, src) });
    }
  }
}

const PROVIDER_CALL = /aliasMiddleware|middlewareGroup|MiddlewareToGroup/;

export function buildRegistry(files: Map<string, { root: SyntaxNode; source: string }>, bootstrap: SyntaxNode | null): Registry {
  const reg: Registry = { aliases: new Map(), groups: new Map(), global: [], hasKernel: false };
  const kernel = [...files.keys()].sort().find((rel) => rel.endsWith('Http/Kernel.php'));
  const defaults = () => {
    for (const [g, members] of Object.entries(DEFAULT_GROUPS)) {
      reg.groups.set(g, { members: members.map((name) => ({ name, text: name, source: 'framework default' })), source: 'framework default' });
    }
    reg.global = DEFAULT_GLOBAL.map((name) => ({ name, text: name, source: 'framework default' }));
  };
  if (kernel) {
    reg.hasKernel = true;
    const f = files.get(kernel)!;
    kernelProperties(kernel, f.root, collectFileScope(f.root), reg);
    if (!reg.groups.size) defaults();
  } else {
    defaults();
  }
  const edits = new GroupEdits();
  if (bootstrap) bootstrapMiddleware(bootstrap, collectFileScope(bootstrap), reg, edits);
  for (const rel of [...files.keys()].sort()) {
    if (rel === kernel || rel.startsWith('routes/')) continue;
    const f = files.get(rel)!;
    if (PROVIDER_CALL.test(f.source)) providerCalls(rel, f.root, collectFileScope(f.root), reg, edits);
  }
  edits.apply(reg.groups);
  return reg;
}
