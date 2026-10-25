import { describe, expect, it } from 'vitest';
import { matchCall, matchPath, type PatternedEndpoint } from '../src/match/match.js';
import { laravelPattern, nextPattern, normalizeCallUrl, patternKey } from '../src/match/url.js';
import type { UrlPart } from '../src/types.js';

const lit = (v: string): UrlPart => ({ t: 'lit', v });
const env = (name: string): UrlPart => ({ t: 'env', name });
const hole: UrlPart = { t: 'expr', text: 'id' };
const opts = { backendEnvVars: [], backendHosts: ['api.example.com'] };
const norm = (parts: UrlPart[], o = opts) => normalizeCallUrl(parts, o);

describe('URL normalization', () => {
  it('builds endpoint patterns', () => {
    expect(patternKey(laravelPattern('/api/users/{user}/posts/{post?}'))).toBe('/api/users/*/posts/*?');
    expect(patternKey(laravelPattern('/files/file-{id}.pdf'))).toBe('/files/file-*.pdf');
    expect(patternKey(nextPattern('/api/users/[id]'))).toBe('/api/users/*');
    expect(patternKey(nextPattern('/docs/[...slug]'))).toBe('/docs/**');
    expect(patternKey(nextPattern('/shop/[[...rest]]'))).toBe('/shop/**?');
  });

  it('treats env / base-URL prefixes as the backend and strips them', () => {
    expect(norm([env('NEXT_PUBLIC_API_URL'), lit('/api/users/'), hole])).toMatchObject({ target: 'backend', display: '/api/users/*' });
    expect(norm([{ t: 'base', name: 'API_URL' }, lit('/x')])).toMatchObject({ target: 'backend', display: '/x' });
  });

  it('restricts env vars when configured', () => {
    const o = { backendEnvVars: ['NEXT_PUBLIC_API_URL'], backendHosts: [] };
    expect(norm([env('NEXT_PUBLIC_API_URL'), lit('/a')], o)?.target).toBe('backend');
    expect(norm([env('NEXT_PUBLIC_CDN'), lit('/a')], o)?.target).toBe('suffix');
  });

  it('strips protocol, host, port, query, hash and trailing slashes', () => {
    expect(norm([lit('http://localhost:8000/api/users/?page=2#top')])).toMatchObject({ target: 'backend', display: '/api/users' });
    expect(norm([lit('https://api.example.com/v1/x/')])).toMatchObject({ target: 'backend', display: '/v1/x' });
    expect(norm([lit('https://api.github.com/repos/x')])).toMatchObject({ target: 'external', display: '/repos/x' });
    expect(norm([lit('/api/search?q='), hole])).toMatchObject({ target: 'relative', display: '/api/search' });
  });

  it('classifies relative URLs and unknown leading interpolations', () => {
    expect(norm([lit('/api/session')])).toMatchObject({ target: 'relative', display: '/api/session' });
    expect(norm([{ t: 'ident', name: 'base' }, lit('/api/posts')])).toMatchObject({ target: 'suffix', display: '…/api/posts' });
    expect(norm([lit('https://'), hole, lit('/api/x')])).toMatchObject({ target: 'suffix' });
    // Nothing static left to match on.
    expect(norm([{ t: 'ident', name: 'url' }])).toBeNull();
  });

  it('makes interpolated segments wildcards and keeps mixed segments as patterns', () => {
    const n = norm([lit('/api/users/'), hole, lit('/avatar-'), hole, lit('.png')]);
    expect(n?.segments.map((s) => s.k)).toEqual(['lit', 'lit', 'wild', 'mixed']);
    expect(n?.display).toBe('/api/users/*/avatar-*.png');
  });
});

const ep = (server: 'laravel' | 'next', methods: string[], path: string): PatternedEndpoint => ({
  id: `endpoint:${server}:${methods.join('|')} ${path}`,
  server,
  methods,
  path,
  file: 'x',
  line: 1,
  handler: null,
  handlerCertain: true,
  segs: server === 'laravel' ? laravelPattern(path) : nextPattern(path),
});

describe('endpoint matching', () => {
  const laravel = [
    ep('laravel', ['GET'], '/api/users'),
    ep('laravel', ['GET'], '/api/users/{user}'),
    ep('laravel', ['GET'], '/api/users/me'),
    ep('laravel', ['PATCH', 'PUT'], '/api/users/{user}'),
    ep('laravel', ['GET'], '/api/reports/{year?}'),
    ep('laravel', ['ANY'], '/api/hook'),
    ep('laravel', ['GET'], '/api/me'),
  ];
  const next = [ep('next', ['GET'], '/api/session'), ep('next', ['GET'], '/api/docs/[...slug]')];
  const ids = (r: ReturnType<typeof matchCall>) => r?.endpoints.map((e) => e.id.replace(/^endpoint:/, ''));

  it('requires equal segment counts and static segments, with optional params', () => {
    const segs = (parts: UrlPart[]) => norm(parts)!.segments;
    expect(matchPath(segs([lit('/api/reports')]), laravelPattern('/api/reports/{year?}'), false)).not.toBeNull();
    expect(matchPath(segs([lit('/api/reports/'), hole]), laravelPattern('/api/reports/{year?}'), false)).not.toBeNull();
    expect(matchPath(segs([lit('/api/reports/2024/x')]), laravelPattern('/api/reports/{year?}'), false)).toBeNull();
    expect(matchPath(segs([lit('/api/users')]), laravelPattern('/api/posts'), false)).toBeNull();
  });

  it('prefers the most specific endpoint', () => {
    expect(ids(matchCall(norm([env('API'), lit('/api/users/me')])!, 'GET', laravel, next))).toEqual(['laravel:GET /api/users/me']);
    expect(ids(matchCall(norm([env('API'), lit('/api/users/'), hole])!, 'GET', laravel, next))).toEqual(['laravel:GET /api/users/{user}']);
  });

  it('checks methods: PUT and PATCH both reach update, ANY matches everything, unknown is uncertain', () => {
    const put = matchCall(norm([env('API'), lit('/api/users/5')])!, 'PUT', laravel, next);
    expect(ids(put)).toEqual(['laravel:PATCH|PUT /api/users/{user}']);
    expect(put?.certain).toBe(true);
    expect(ids(matchCall(norm([env('API'), lit('/api/users/5')])!, 'PATCH', laravel, next))).toEqual(['laravel:PATCH|PUT /api/users/{user}']);
    expect(matchCall(norm([env('API'), lit('/api/users/5')])!, 'DELETE', laravel, next)).toBeNull();
    expect(ids(matchCall(norm([env('API'), lit('/api/hook')])!, 'POST', laravel, next))).toEqual(['laravel:ANY /api/hook']);
    const unknown = matchCall(norm([env('API'), lit('/api/users/5')])!, null, laravel, next);
    expect(ids(unknown)).toEqual(['laravel:GET /api/users/{user}', 'laravel:PATCH|PUT /api/users/{user}']);
    expect(unknown?.certain).toBe(false);
  });

  it('matches relative URLs against Next.js handlers first, then Laravel (uncertain)', () => {
    const s = matchCall(norm([lit('/api/session')])!, 'GET', laravel, next);
    expect(ids(s)).toEqual(['next:GET /api/session']);
    expect(s?.certain).toBe(true);
    const me = matchCall(norm([lit('/api/me')])!, 'GET', laravel, next);
    expect(ids(me)).toEqual(['laravel:GET /api/me']);
    expect(me).toMatchObject({ certain: false, via: 'relative' });
    expect(ids(matchCall(norm([lit('/api/docs/a/b/c')])!, 'GET', laravel, next))).toEqual(['next:GET /api/docs/[...slug]']);
  });

  it('matches unknown bases by static suffix, uncertain', () => {
    const r = matchCall(norm([{ t: 'ident', name: 'base' }, lit('/users')])!, 'GET', laravel, next);
    expect(ids(r)).toEqual(['laravel:GET /api/users']);
    expect(r).toMatchObject({ certain: false, via: 'suffix' });
  });

  it('requires static suffix segments to meet literal route segments', () => {
    // "/session" must not match every route that ends in a parameter.
    expect(matchCall(norm([{ t: 'ident', name: 'base' }, lit('/session')])!, 'GET', laravel, [])).toBeNull();
    const r = matchCall(norm([{ t: 'ident', name: 'base' }, lit('/users/'), hole])!, 'GET', laravel, next);
    expect(ids(r)).toEqual(['laravel:GET /api/users/{user}']);
  });

  it('flags matches that fan out to many endpoints as ambiguous', () => {
    const many = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => ep('laravel', [m], `/api/things/{thing}`));
    const r = matchCall(norm([env('API'), lit('/api/things/1')])!, null, many, []);
    expect(r?.ambiguous).toBe(true);
    expect(r?.endpoints).toHaveLength(6);
  });

  it('returns null when nothing matches', () => {
    expect(matchCall(norm([env('API'), lit('/api/v1/analytics')])!, 'POST', laravel, next)).toBeNull();
  });
});
