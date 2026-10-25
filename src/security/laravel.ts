import type { SecurityOptions } from '../config.js';
import type { PhpClass } from '../lang/php/extract.js';
import type { LaravelAdapter } from '../lang/php/index.js';
import type { MiddlewareUse, RawRoute } from '../lang/php/routes.js';
import type { SyntaxNode } from '../parse.js';
import { scanChecks, formRequests, type CodeCheck } from './code.js';
import { ControllerInspector } from './controller.js';
import { FUNCTION_TYPES, PhpIndex } from './php.js';
import { buildRegistry, type Registry } from './registry.js';
import { MiddlewareResolver, strongest, type Leaf } from './resolver.js';
import type { Confidence, Effect, Signal } from './types.js';

/** Per-endpoint findings before the state is decided (index.ts adds callers, reach and review flags). */
export interface LaravelFindings {
  endpointId: string;
  signals: Signal[];
  /** Unknown reason codes with the text that caused them. */
  unknown: { reason: string; text: string }[];
  notes: string[];
  middleware: string[];
  loader: RawRoute['loader'];
  /** Unknown middleware names on this endpoint (for the unresolved table). */
  unresolved: { name: string; reason: string; hint?: string }[];
}

/** One written middleware entry plus where it came from. */
interface Entry {
  name: string | null;
  text: string;
  file: string;
  line: number;
  source: Signal['source'];
  maybe: boolean;
}

const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

export class LaravelSecurity {
  readonly registry: Registry;
  readonly resolver: MiddlewareResolver;
  readonly index: PhpIndex;
  private controllers: ControllerInspector;
  /** method id -> declaring class + method name, to scan code reached through calls edges. */
  private methods = new Map<string, { cls: PhpClass; name: string }>();
  private bodyChecks = new Map<string, CodeCheck[]>();

  constructor(
    private laravel: LaravelAdapter,
    options: SecurityOptions,
  ) {
    this.index = new PhpIndex(laravel);
    const files = new Map<string, { root: SyntaxNode; source: string }>();
    for (const [rel, f] of laravel.parsed) files.set(rel, { root: f.tree.rootNode, source: f.source });
    this.registry = buildRegistry(files, laravel.bootstrap);
    this.resolver = new MiddlewareResolver(this.registry, this.index, options);
    this.controllers = new ControllerInspector(this.index);
    for (const info of laravel.infos) for (const cls of info.classes) for (const m of cls.methods) this.methods.set(`${cls.id}::${m.name}`, { cls, name: m.name });
  }

  /** Global middleware, classified (it runs before every route). */
  globalLeaves(): { ref: Registry['global'][number]; leaves: Leaf[] }[] {
    return this.registry.global.map((ref) => ({ ref, leaves: this.resolver.expand(ref.name, ref.text) }));
  }

  /** Analyze the route that registered each endpoint (the last registration wins, as in Laravel). */
  analyze(callees: (id: string) => string[]): LaravelFindings[] {
    const winners = new Map<string, RawRoute>();
    for (const r of this.laravel.routes) if (r.endpointId) winners.set(r.endpointId, r);
    const global = this.globalLeaves();
    return [...winners.values()].map((r) => this.route(r, global, callees));
  }

  private route(r: RawRoute, global: ReturnType<LaravelSecurity['globalLeaves']>, callees: (id: string) => string[]): LaravelFindings {
    const f: LaravelFindings = { endpointId: r.endpointId!, signals: [], unknown: [], notes: [], middleware: [], loader: r.loader, unresolved: [] };
    const entries: Entry[] = [];
    const toEntry = (m: MiddlewareUse): Entry => ({ name: m.name, text: m.text, file: m.file, line: m.line, source: m.via, maybe: false });
    entries.push(...r.middleware.map(toEntry));

    // Controller-level middleware for this action.
    let controller: PhpClass | null = null;
    const exclusions: { name: string | null; text: string; file: string; line: number }[] = [...r.excludedMiddleware];
    if (r.action.type === 'controller' && r.resolved) {
      controller = this.index.findClass(r.resolved);
      if (controller) {
        const c = this.controllers.inspect(controller, r.action.method);
        f.unknown.push(...c.unknown);
        exclusions.push(...c.excluded);
        for (const m of c.middleware) {
          if (m.closure) {
            f.unknown.push({ reason: 'closure-middleware', text: `closure middleware ${m.text} (${m.file}:${m.line})` });
            continue;
          }
          const where = m.inherited ? ` (inherited from ${m.inherited.split('\\').pop()})` : '';
          entries.push({ name: m.name, text: m.text + where, file: m.file, line: m.line, source: 'controller', maybe: m.applies === 'maybe' });
        }
      }
    }

    // withoutMiddleware(): Laravel drops a resolved class when it equals an excluded one (parameters included) or extends it.
    const excluded = new Set(exclusions.flatMap((m) => this.resolver.expand(m.name, m.text)).map((l) => l.key).filter((k): k is string => k !== null));
    const isExcluded = (leaf: Leaf) => {
      if (!leaf.key || !excluded.size) return false;
      if (excluded.has(leaf.key)) return true;
      return !leaf.key.includes(':') && this.resolver.ancestors(leaf.key).some((a) => excluded.has(a));
    };
    for (const m of exclusions) f.notes.push(`${m.text.startsWith('#[') ? m.text : `withoutMiddleware(${m.text})`} at ${m.file}:${m.line}`);

    // Global middleware first, then loader/group/route/controller entries.
    for (const g of global) {
      const at = /^(.+):(\d+)$/.exec(g.ref.source);
      const entry: Entry = { name: g.ref.name, text: g.ref.text, file: at?.[1] ?? '', line: at ? Number(at[2]) : 0, source: 'global', maybe: false };
      for (const leaf of g.leaves) if (!isExcluded(leaf)) this.leafSignal(f, leaf, entry, true);
    }
    for (const e of entries) {
      const leaves = this.resolver.expand(e.name, e.text).filter((l) => !isExcluded(l));
      if (!leaves.length) {
        f.notes.push(`${e.text}: removed by withoutMiddleware`);
        continue;
      }
      const label = e.source === 'loader' ? `${e.text} (route file group)` : e.source === 'controller' ? `${e.text} (controller${e.maybe ? ', may apply' : ''})` : e.text;
      f.middleware.push(label);
      for (const leaf of leaves) this.leafSignal(f, leaf, e, false);
    }
    if (r.loader === 'unknown') f.unknown.push({ reason: 'unknown-loader', text: `${r.file} is not loaded by bootstrap/app.php or a route provider CodeMap read` });
    if (r.loader === 'convention') f.notes.push(`${r.file} assumed to be loaded with the '${r.file === 'routes/api.php' ? 'api' : 'web'}' group (Laravel convention; no loader found)`);

    // Handler code: FormRequest authorize(), checks in the body, and checks one or two calls away.
    const handler = this.handlerNode(r, controller);
    if (!handler) {
      f.unknown.push({ reason: 'handler-not-found', text: r.action.type === 'controller' ? `${r.action.classes[0]}@${r.action.method}` : 'route action' });
    } else {
      const scope = this.index.scope(handler.file, handler.node.startIndex);
      for (const fr of formRequests(handler.node, scope, this.index)) {
        const name = fr.cls.name;
        if (fr.authorize === 'check') {
          f.signals.push({
            effect: 'authorization',
            source: 'form-request',
            text: `${name}::authorize()`,
            detail: 'runs before the handler; its logic was not evaluated',
            confidence: 'medium',
            file: fr.authorizeFile,
            line: fr.authorizeLine,
          });
        } else if (fr.authorize === 'true') {
          f.notes.push(`${name}::authorize() always returns true (${fr.authorizeFile}:${fr.authorizeLine})`);
        }
      }
      const body = handler.node.childForFieldName('body');
      if (body) {
        for (const c of scanChecks(body, scope, handler.file)) this.codeSignal(f, c, 'handler');
        const seen = new Set<string>();
        let frontier = r.handlerId ? callees(r.handlerId) : [];
        for (let depth = 1; depth <= 2 && frontier.length; depth++) {
          const next: string[] = [];
          for (const id of frontier) {
            if (seen.has(id)) continue;
            seen.add(id);
            for (const c of this.checksIn(id)) if (c.kind === 'throwing' || c.kind === 'enforced') this.codeSignal(f, c, 'called-code');
            next.push(...callees(id));
          }
          frontier = next;
        }
      }
    }
    return f;
  }

  private leafSignal(f: LaravelFindings, leaf: Leaf, e: Entry, global: boolean): void {
    if (leaf.effect === 'neutral') return;
    if (leaf.effect === 'unknown') {
      const reason = e.maybe ? 'conditional-controller-middleware' : leaf.unknown?.reason ?? 'custom-middleware';
      f.unknown.push({ reason, text: `${global ? 'global ' : ''}${e.text}: ${leaf.detail}` });
      if (leaf.unknown) f.unresolved.push({ name: leaf.unknown.name, reason: leaf.unknown.reason, hint: leaf.unknown.hint });
      return;
    }
    if (e.maybe) {
      // An access middleware that may not apply to this action: do not count it, but do not ignore it.
      f.unknown.push({ reason: 'conditional-controller-middleware', text: `${e.text}: ${leaf.detail}` });
      return;
    }
    f.signals.push({ effect: leaf.effect, source: e.source, text: e.text, detail: leaf.detail, confidence: leaf.confidence, ...(e.file ? { file: e.file, line: e.line } : {}) });
  }

  private codeSignal(f: LaravelFindings, c: CodeCheck, source: 'handler' | 'called-code'): void {
    const where = { file: c.file, line: c.line };
    if (c.kind === 'throwing' || c.kind === 'enforced') {
      f.signals.push({
        effect: 'authorization',
        source,
        text: c.text,
        detail:
          (c.kind === 'throwing' ? 'throws when the check fails' : 'request aborted when the check fails') +
          (source === 'called-code' ? '; in code the handler calls' : '') +
          '; whether every path reaches it was not checked',
        confidence: source === 'handler' ? 'medium' : 'low',
        ...where,
      });
    } else {
      f.unknown.push({ reason: 'check-in-code', text: `${c.text} (${c.file}:${c.line})` });
    }
  }

  private checksIn(methodId: string): CodeCheck[] {
    let cached = this.bodyChecks.get(methodId);
    if (cached) return cached;
    cached = [];
    const m = this.methods.get(methodId);
    const found = m ? this.index.methodBody(m.cls, m.name) : null;
    const body = found?.node.childForFieldName('body');
    if (found && body) cached = scanChecks(body, this.index.scope(found.file, body.startIndex), found.file);
    this.bodyChecks.set(methodId, cached);
    return cached;
  }

  /** The closure or controller method that handles the route. */
  private handlerNode(r: RawRoute, controller: PhpClass | null): { node: SyntaxNode; file: string } | null {
    if (r.action.type === 'closure') {
      const root = this.index.tree(r.file);
      let n = root?.descendantForIndex(r.action.startIndex, r.action.endIndex) ?? null;
      while (n && !FUNCTION_TYPES.has(n.type)) n = n.parent;
      return n ? { node: n, file: r.file } : null;
    }
    if (r.action.type === 'controller' && controller) {
      const m = this.index.findMethod(controller, r.action.method);
      return m ? { node: m.node, file: m.file } : null;
    }
    return null;
  }
}

/** Decide the state from findings: strongest signal wins; unknown only when nothing restricting was found. */
/** `noneConfidence`: how sure "no protection found" is (high when every middleware source was seen). */
export function decide(signals: Signal[], unknown: { reason: string }[], noneConfidence: Confidence): { state: import('./types.js').ProtectionState; confidence: Confidence; lead: Signal | null } {
  const byEffect = (e: Effect) => signals.filter((s) => s.effect === e).sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence]);
  const top = strongest(signals.map((s) => s.effect));
  const pick = (e: Effect) => byEffect(e)[0];
  switch (top) {
    case 'authorization':
      return { state: 'authorization', confidence: pick('authorization').confidence, lead: pick('authorization') };
    case 'authentication':
      return { state: 'authenticated', confidence: pick('authentication').confidence, lead: pick('authentication') };
    case 'signed':
      return { state: 'signed', confidence: pick('signed').confidence, lead: pick('signed') };
    case 'public':
      return { state: 'public', confidence: pick('public').confidence, lead: pick('public') };
    default:
      if (unknown.length) return { state: 'unknown', confidence: 'low', lead: null };
      return { state: 'none', confidence: noneConfidence, lead: null };
  }
}
