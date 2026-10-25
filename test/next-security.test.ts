import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { defaultConfig } from '../src/config.js';
import { matcherRegex, samplePath } from '../src/security/next.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'next-protection');
const report = analyze({ backend: null, frontend: fixture, config: defaultConfig(), security: true }).graph.security!;
const byId = new Map([...report.endpoints, ...(report.actions ?? [])].map((e) => [e.id.replace(/^(endpoint:next:|fe:)/, ''), e]));

describe('Next.js middleware matcher', () => {
  it('turns path-to-regexp matchers into regexes', () => {
    const all = matcherRegex('/((?!api|_next/static|_next/image|favicon.ico).*)')!;
    expect(['/dashboard', '/dashboard/settings', '/'].map((p) => all.test(p))).toEqual([true, true, true]);
    expect(['/api/me', '/_next/static/chunk.js', '/favicon.ico'].map((p) => all.test(p))).toEqual([false, false, false]);

    const dash = matcherRegex('/dashboard/:path*')!;
    expect(['/dashboard', '/dashboard/a', '/dashboard/a/b', '/dashboards', '/admin'].map((p) => dash.test(p))).toEqual([true, true, true, false, false]);
    expect(matcherRegex('/admin/:id')!.test('/admin/7')).toBe(true);
    expect(matcherRegex('/admin/:id')!.test('/admin')).toBe(false);
    expect(matcherRegex('/(unclosed')).toBeNull();
  });

  it('samples dynamic segments with a placeholder', () => {
    expect(samplePath('/api/items/[id]')).toBe('/api/items/x');
    expect(samplePath('/docs/[...slug]')).toBe('/docs/x');
    expect(samplePath('/shop/[[...rest]]')).toBe('/shop');
  });
});

describe('security lens on fixtures/next-protection', () => {
  it('classifies route handlers as their comments say', () => {
    const states = Object.fromEntries([...byId].filter(([, e]) => e.kind !== 'action').map(([id, e]) => [id, e.state]));
    expect(states).toEqual({
      'ANY /api/legacy/items': 'none', // pages router, decided per method: GET is public
      'DELETE /api/admin/users': 'authorization',
      'GET /api/admin/stats': 'authorization',
      'GET /api/admin/users': 'authorization',
      'GET /api/announcements': 'authenticated', // a positive role branch grants more; it refuses nobody
      'GET /api/cron/cleanup': 'authenticated',
      'GET /api/cron/report': 'authenticated',
      'GET /api/feed': 'unknown',
      'GET /api/limited': 'unknown',
      'GET /api/listings': 'none',
      'GET /api/me': 'authenticated',
      'GET /api/proxy': 'none', // hasUpstreamAuth() only checks configuration
      'GET /api/reports': 'authenticated',
      'GET /api/webhooks/verify': 'authenticated',
      'GET /dashboard/export': 'authenticated',
      'POST /api/ai': 'none', // a configured API key says nothing about the caller
      'POST /api/ingest': 'unknown', // verifyGatewayToken() returns null without a token
      'POST /api/partner': 'unknown', // stops on a package function SeamMap cannot read
      'POST /api/projects': 'authenticated',
      'POST /api/webhooks/stripe': 'authenticated',
    });
  });

  it('classifies server actions, including form input named role and config checks', () => {
    const actions = (report.actions ?? []).map((a) => [a.id.split('#')[1], a.state, a.kind]);
    expect(actions).toEqual([
      ['deleteAccount', 'authorization', 'action'],
      ['generateSummary', 'none', 'action'],
      ['getAdminStats', 'authorization', 'action'],
      ['saveRoleRequest', 'none', 'action'],
      ['updateProfile', 'authenticated', 'action'],
    ]);
    expect(report.actionSummary).toEqual({ authorization: 2, authenticated: 1, signed: 0, public: 0, unknown: 0, none: 2 });
    expect(byId.get('app/dashboard/settings/actions.ts#updateProfile')!.frontendCallers).toBe(1);
  });

  it('says where each state comes from', () => {
    const sig = (id: string) => byId.get(id)!.signals.map((s) => [s.source, s.text]);
    expect(sig('GET /api/admin/users')).toEqual([
      ['handler', 'if (!user)'],
      ['handler', "if (user.role !== 'admin')"],
    ]);
    expect(sig('DELETE /api/admin/users')).toEqual([['called-code', 'requireAdmin()']]);
    expect(sig('GET /api/reports')).toEqual([['called-code', 'handleReport()']]);
    expect(sig('POST /api/projects')).toEqual([['called-code', 'if (!user)']]);
    expect(sig('GET /dashboard/export')).toEqual([['middleware', "if (!user && request.nextUrl.pathname.startsWith('/dashboard'))"]]);
    expect(sig('GET /api/webhooks/verify')).toEqual([['handler', 'if (expected && token === expected)']]);
    expect(byId.get('GET /api/cron/cleanup')!.signals[0].detail).toMatch(/shared secret/);
    expect(byId.get('GET /api/cron/report')!.signals[0]).toMatchObject({ text: 'if (!authorized)', detail: expect.stringMatching(/shared secret/) });
    expect(sig('GET /api/admin/stats')).toEqual([['called-code', 'assertAdmin()']]);
    expect(byId.get('GET /api/admin/stats')!.unknown).toEqual([]); // the user it was given counts as guarded
    expect(byId.get('POST /api/webhooks/stripe')!).toMatchObject({ confidence: 'low', signals: [{ text: 'try { ….webhooks.constructEvent(…) } catch' }] });
    // Middleware gates /dashboard only: the API routes get nothing from it.
    expect(byId.get('GET /api/me')!.signals.some((s) => s.source === 'middleware')).toBe(false);
  });

  it('keeps what it cannot read as unknown, never as no protection', () => {
    expect(byId.get('GET /api/feed')!.unknown).toEqual(['check-in-code']);
    expect(byId.get('GET /api/limited')!.unknown).toEqual(['wrapper-not-analyzed']);
    expect(byId.get('POST /api/ingest')!.unknown).toEqual(['check-in-code']);
    expect(byId.get('POST /api/partner')!.unknown).toEqual(['unresolved-auth-helper']);
    expect(byId.get('POST /api/partner')!.notes.join('\n')).toMatch(/verifyRequest\(\) decides whether the request goes on/);
    expect(report.unknownReasons.map((r) => r.reason).sort()).toEqual(['check-in-code', 'unresolved-auth-helper', 'wrapper-not-analyzed']);
  });

  it('decides a handler that dispatches by method one method at a time and shows the weakest', () => {
    const items = byId.get('ANY /api/legacy/items')!;
    expect(items.notes).toContain('handled per method: GET none, DELETE authenticated; the weakest (GET) is shown');
    expect(items.signals).toEqual([]);
  });

  it('reports the middleware matcher, its gates and the limits', () => {
    expect(report.nextMiddleware).toMatchObject({
      file: 'middleware.ts',
      matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
      gates: [{ kind: 'authentication', file: 'middleware.ts', line: 12, evaluated: true }],
    });
    expect(report.caveats.join('\n')).toMatch(/1 inline 'use server' function/);
    expect(report.caveats.join('\n')).toMatch(/row-level security/);
  });
});
