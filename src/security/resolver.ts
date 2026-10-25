import type { SecurityOptions } from '../config.js';
import type { PhpClass } from '../lang/php/extract.js';
import type { SyntaxNode } from '../parse.js';
import { DEFAULT_ALIASES, KNOWN_CLASSES } from './catalog.js';
import type { Registry } from './registry.js';
import type { Confidence, Effect } from './types.js';

/** Why something stayed unresolved. Keys are stable (used in graph.json and config hints). */
export const UNKNOWN_LABELS: Record<string, string> = {
  'custom-middleware': 'custom middleware SeamMap does not classify',
  'vendor-middleware': 'package middleware not in the catalog',
  'undefined-alias': 'middleware alias not defined in Kernel.php, bootstrap/app.php or a provider',
  'non-literal-middleware': 'middleware written as a non-literal expression',
  'closure-middleware': 'closure middleware in a controller',
  'conditional-controller-middleware': 'controller middleware whose only/except or condition could not be read',
  'parent-controller-not-scanned': 'controller extends a class outside the project',
  'attribute-middleware': 'PHP attribute on the controller or action that may add middleware (not read)',
  'handler-not-found': 'handler code not found (FormRequest and in-code checks not inspected)',
  'unknown-loader': 'route file loaded by code SeamMap did not see',
  'check-in-code': 'access check in handler code whose effect was not evaluated',
  'next-handler': 'Next.js route handler (not analyzed)',
  'auth-library-route': "the auth library's own route (NextAuth handlers), not analyzed",
  'next-handler-not-found': 'Next.js handler function not found',
  'unresolved-auth-helper': 'auth-looking helper that could not be followed',
  'wrapper-not-analyzed': 'route handler wrapped in a function SeamMap could not read',
  'middleware-unevaluated': 'middleware.ts gate whose path condition was not evaluated',
};

/** One resolved middleware class (or what is left of a name that did not resolve). */
export interface Leaf {
  /** What Laravel's resolver would produce: FQN plus ':params', the unresolved alias string, or null. */
  key: string | null;
  effect: Effect;
  detail: string;
  confidence: Confidence;
  unknown?: { reason: string; name: string; hint?: string };
}

export interface ClassIndex {
  findClass(fqn: string): PhpClass | null;
  /** Body of a method declared on the class (not inherited), if available. */
  methodBody(cls: PhpClass, name: string): { node: SyntaxNode; file: string } | null;
}

const RANK: Record<Effect, number> = { authorization: 5, authentication: 4, signed: 3, public: 2, unknown: 1, neutral: 0 };
export const strongest = (effects: Effect[]): Effect => effects.reduce<Effect>((a, b) => (RANK[b] > RANK[a] ? b : a), 'neutral');
const short = (fqn: string) => fqn.split('\\').pop() ?? fqn;

export class MiddlewareResolver {
  private config = new Map<string, Effect>();
  private classCache = new Map<string, Leaf>();
  private hints = new Map<string, string | undefined>();

  constructor(
    readonly registry: Registry,
    private index: ClassIndex,
    options: SecurityOptions,
  ) {
    // Later lists win on conflict; strongest last.
    const lists: [string[], Effect][] = [
      [options.ignoreMiddleware, 'neutral'],
      [options.publicMiddleware, 'public'],
      [options.authMiddleware, 'authentication'],
      [options.authorizationMiddleware, 'authorization'],
    ];
    for (const [names, effect] of lists) for (const n of names) this.config.set(norm(n), effect);
  }

  private fromConfig(names: string[]): { effect: Effect; matched: string } | null {
    for (const n of names) {
      const effect = this.config.get(norm(n));
      if (effect) return { effect, matched: n };
    }
    return null;
  }

  /** Expand one middleware name into the classes it stands for, following Laravel's resolution order (group, then alias). */
  expand(name: string | null, text = name ?? '', stack: string[] = []): Leaf[] {
    if (name === null) {
      return [{ key: null, effect: 'unknown', detail: 'not a literal', confidence: 'low', unknown: { reason: 'non-literal-middleware', name: text } }];
    }
    const [base, ...rest] = name.split(':');
    const params = rest.length ? ':' + rest.join(':') : '';
    const configured = this.fromConfig([name, base]);
    const group = this.registry.groups.get(name);
    const alias = this.registry.aliases.get(base);
    const target = alias?.target ?? (base.includes('\\') ? null : DEFAULT_ALIASES[base]);
    if (configured) {
      const key = group ? name : target ? target + params : name;
      return [{ key, effect: configured.effect, detail: `${name}: ${configured.effect} (seammap.config.json)`, confidence: 'high' }];
    }
    if (group && !stack.includes(name)) {
      return group.members.flatMap((m) => this.expand(m.name, m.text, [...stack, name]).map((l) => ({ ...l, detail: `group ${name} > ${l.detail}` })));
    }
    if (base.includes('\\')) return [this.classify(base, params)];
    if (target) {
      const leaf = this.classify(target, params);
      const via = alias ? `alias ${base} (${alias.source})` : `alias ${base} (framework default)`;
      return [{ ...leaf, detail: `${via} -> ${leaf.detail}` }];
    }
    return [
      {
        key: name,
        effect: 'unknown',
        detail: `alias '${base}' is not defined in the files SeamMap reads`,
        confidence: 'low',
        unknown: { reason: 'undefined-alias', name: base, hint: 'may be registered by a package; classify it in security config' },
      },
    ];
  }

  /** Classify a middleware class: config, catalog, then the project's `extends` chain. */
  classify(fqn: string, params = ''): Leaf {
    const cacheKey = fqn.toLowerCase();
    let leaf = this.classCache.get(cacheKey);
    if (!leaf) {
      leaf = this.classifyUncached(fqn);
      this.classCache.set(cacheKey, leaf);
    }
    return { ...leaf, key: fqn + params };
  }

  private classifyUncached(fqn: string): Leaf {
    const lookup = (name: string): { effect: Effect; label: string; how: string } | null => {
      const c = this.fromConfig([name]);
      if (c) return { effect: c.effect, label: c.effect, how: 'seammap.config.json' };
      const k = KNOWN_CLASSES.get(name.toLowerCase());
      return k ? { effect: k.effect, label: k.label, how: 'catalog' } : null;
    };
    const direct = lookup(fqn);
    if (direct) return { key: fqn, effect: direct.effect, detail: `${short(fqn)}: ${direct.label}`, confidence: 'high' };
    let cls = this.index.findClass(fqn);
    if (!cls) {
      return {
        key: fqn,
        effect: 'unknown',
        detail: `${fqn} is neither in the project nor in the catalog`,
        confidence: 'low',
        unknown: { reason: 'vendor-middleware', name: fqn, hint: 'package class; classify it in security config' },
      };
    }
    const chain = [cls.fqn];
    const overridesHandle = (c: PhpClass) => c.methods.some((m) => m.name.toLowerCase() === 'handle');
    let overridden = overridesHandle(cls);
    for (let depth = 0; depth < 8; depth++) {
      const parent = cls.extends[0];
      if (!parent) break;
      const hit = lookup(parent);
      if (hit) {
        return {
          key: fqn,
          effect: hit.effect,
          detail: `${short(fqn)} extends ${chain.length > 1 ? chain.slice(1).map(short).join(' -> ') + ' -> ' : ''}${parent}: ${hit.label}${overridden ? ' (handle() overridden; body not checked)' : ''}`,
          confidence: overridden && hit.effect !== 'neutral' ? 'medium' : 'high',
        };
      }
      const next = this.index.findClass(parent);
      if (!next) {
        return {
          key: fqn,
          effect: 'unknown',
          detail: `${short(fqn)} extends ${parent}, which is neither in the project nor in the catalog`,
          confidence: 'low',
          unknown: { reason: 'vendor-middleware', name: fqn, hint: this.hint(cls) },
        };
      }
      cls = next;
      chain.push(cls.fqn);
      overridden ||= overridesHandle(cls);
    }
    // The Laravel <= 10 skeleton ships RedirectIfAuthenticated as a standalone class behind the 'guest' alias.
    if (cls.name === 'RedirectIfAuthenticated' && chain.length === 1) {
      return { key: fqn, effect: 'public', detail: `${short(fqn)}: Laravel skeleton guest middleware (body not checked)`, confidence: 'medium' };
    }
    return {
      key: fqn,
      effect: 'unknown',
      detail: `${short(fqn)} is project middleware SeamMap does not classify`,
      confidence: 'low',
      unknown: { reason: 'custom-middleware', name: fqn, hint: this.hint(cls) },
    };
  }

  /**
   * Suggestion for the config, from the handle() body. Shown next to the unknown entry;
   * it never changes the classification.
   */
  hint(cls: PhpClass): string | undefined {
    if (this.hints.has(cls.fqn)) return this.hints.get(cls.fqn);
    const body = this.index.methodBody(cls, 'handle');
    let hint: string | undefined;
    if (body) {
      const t = body.node.text;
      const stops = /\babort(_if|_unless)?\s*\(|\bthrow\b|\bredirect\s*\(|\bresponse\s*\(|Response::|->json\s*\(/.test(t);
      if (/AuthenticationException|->authenticate\s*\(|Auth::(check|guest)\(|auth\(\)->(check|guest)\(/.test(t)) hint = 'handle() looks like an authentication check: consider security.authMiddleware';
      else if (/AuthorizationException|\babort\s*\(\s*403|Gate::|->can\s*\(|->cannot\s*\(|hasRole|hasPermission|isAdmin/i.test(t)) hint = 'handle() looks like an authorization check: consider security.authorizationMiddleware';
      else if (!stops && /\$next\s*\(/.test(t)) hint = 'handle() itself never stops the request (methods it calls were not checked): if it does not restrict access, add it to security.ignoreMiddleware';
      else if (stops) hint = `handle() can stop requests (see ${body.file}:${body.node.startPosition.row + 1}); check what it requires`;
    }
    this.hints.set(cls.fqn, hint);
    return hint;
  }

  /** FQNs of the class and its project ancestors (for withoutMiddleware subclass matching). */
  ancestors(fqn: string): string[] {
    const out = [fqn];
    let cls = this.index.findClass(fqn);
    for (let i = 0; cls && i < 8; i++) {
      const parent = cls.extends[0];
      if (!parent) break;
      out.push(parent);
      cls = this.index.findClass(parent);
    }
    return out;
  }
}

function norm(name: string): string {
  return name.replace(/^\\/, '').toLowerCase();
}
