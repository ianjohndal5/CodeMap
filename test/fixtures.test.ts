import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { defaultConfig } from '../src/config.js';
import type { Graph, GraphEdge } from '../src/types.js';

const root = path.resolve(__dirname, '..', 'fixtures');
const run = () => analyze({ backend: path.join(root, 'laravel-api'), frontend: path.join(root, 'next-web'), config: defaultConfig() }).graph;

let graph: Graph;
beforeAll(() => {
  graph = run();
});

const edge = (source: string, target: string, kind: GraphEdge['kind']) =>
  graph.edges.find((e) => e.source === source && e.target === target && e.kind === kind);

/** Assert a chain of edges exists (and is certain unless stated otherwise). */
function expectChain(steps: [string, GraphEdge['kind'], string, boolean?][]) {
  for (const [source, kind, target, certain = true] of steps) {
    const e = edge(source, target, kind);
    expect(e, `${source} -${kind}-> ${target}`).toBeDefined();
    expect(e?.certain, `${source} -${kind}-> ${target} certainty`).toBe(certain);
  }
}

describe('fixture graph', () => {
  it('has the expected stats', () => {
    expect(graph.meta.stats).toMatchObject({
      files: 42,
      definitions: 73,
      endpoints: 17,
      httpCalls: 21,
      unmatchedHttpCalls: 2,
      unmatchedEndpoints: 2,
      unresolvedCalls: 3,
      unresolvedImports: 0,
      unresolvedHandlers: 0,
      parseErrors: 0,
    });
    expect(graph.meta.stats.unresolvedByReason).toEqual({
      'backend:chained-call': 22,
      'backend:untyped-property': 1,
      'backend:untyped-variable': 2,
    });
  });

  it('only scans the files that matter', () => {
    const files = graph.nodes.filter((n) => n.kind === 'file').map((n) => n.file);
    for (const skipped of [
      'vendor/laravel/framework/src/Route.php',
      'database/migrations/2024_01_01_000000_create_users_table.php',
      'tests/Feature/UserTest.php',
      'routes/console.php',
      'routes/channels.php',
      'bootstrap/app.php',
      'src/generated/ignored.ts',
      'public/vendor.min.js',
      'next-env.d.ts',
    ]) {
      expect(files).not.toContain(skipped);
    }
    expect(files).toContain('routes/admin.php');
    expect(files).toContain('app/Support/helpers.php');
  });

  it('extracts every Laravel route with prefixes, resources and includes', () => {
    const laravel = graph.nodes.filter((n) => n.kind === 'endpoint' && n.server === 'laravel').map((n) => n.name);
    expect(laravel.sort()).toEqual(
      [
        'DELETE /api/v1/posts/{post}',
        'GET /',
        'GET /api/health',
        'GET /api/me',
        'GET /api/ping',
        'GET /api/v1/admin/reports/{year?}',
        'GET /api/v1/posts',
        'GET /api/v1/posts/{post}',
        'GET /api/v1/users',
        'GET /api/v1/users/{user}',
        'PATCH|PUT /api/v1/posts/{post}',
        'POST /api/login',
        'POST /api/v1/admin/reports/export',
        'POST /api/v1/users',
        'POST /logout',
      ].sort(),
    );
    const next = graph.nodes.filter((n) => n.kind === 'endpoint' && n.server === 'next').map((n) => n.name);
    expect(next.sort()).toEqual(['ANY /api/hello', 'GET /api/session']);
  });

  it('links component -> endpoint -> controller method -> service -> model', () => {
    expectChain([
      ['fe:src/app/(dashboard)/users/page.tsx#UsersPage', 'renders', 'fe:src/components/UserList.tsx#UserList'],
      ['fe:src/components/UserList.tsx#UserList', 'calls', 'fe:src/lib/users.ts#listUsers'],
      ['fe:src/lib/users.ts#listUsers', 'http', 'endpoint:laravel:GET /api/v1/users'],
      ['endpoint:laravel:GET /api/v1/users', 'handles', 'be:App\\Http\\Controllers\\UserController::index'],
      ['be:App\\Http\\Controllers\\UserController::index', 'calls', 'be:App\\Services\\UserService::list'],
      ['be:App\\Services\\UserService::list', 'calls', 'be:App\\Models\\User'],
    ]);
    // Server component with fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/users/${id}`)
    expectChain([
      ['fe:src/app/(dashboard)/users/[id]/page.tsx#getUser', 'http', 'endpoint:laravel:GET /api/v1/users/*'],
      ['endpoint:laravel:GET /api/v1/users/*', 'handles', 'be:App\\Http\\Controllers\\UserController::show'],
      ['be:App\\Http\\Controllers\\UserController::show', 'calls', 'be:App\\Services\\UserService::find'],
      ['be:App\\Services\\UserService::find', 'calls', 'be:App\\Models\\User'],
    ]);
    // "use client" component using the axios instance from lib/axios.ts (env baseURL), Route::match.
    expectChain([
      ['fe:src/components/PostEditor.tsx#PostEditor', 'http', 'endpoint:laravel:PATCH|PUT /api/v1/posts/*'],
      ['endpoint:laravel:PATCH|PUT /api/v1/posts/*', 'handles', 'be:App\\Http\\Controllers\\PostController::update'],
      ['be:App\\Http\\Controllers\\PostController::update', 'calls', 'be:App\\Models\\Post'],
    ]);
    // Optional {year?} matched by both ternary branches; static service call; helper functions.
    expectChain([
      ['fe:src/app/admin/reports/page.tsx#ReportsPage', 'http', 'endpoint:laravel:GET /api/v1/admin/reports/*?'],
      ['endpoint:laravel:GET /api/v1/admin/reports/*?', 'handles', 'be:App\\Http\\Controllers\\Admin\\ReportController::index'],
      ['be:App\\Http\\Controllers\\Admin\\ReportController::index', 'calls', 'be:App\\Services\\ReportService::summary'],
      ['be:App\\Services\\ReportService::summary', 'calls', 'be:format_report_date()'],
      ['be:format_report_date()', 'calls', 'be:now_iso()'],
    ]);
    expect(edge('fe:src/app/admin/reports/page.tsx#ReportsPage', 'endpoint:laravel:GET /api/v1/admin/reports/*?', 'http')?.count).toBe(2);
  });

  it('routes relative calls to Next.js handlers and proxies them to Laravel', () => {
    expectChain([
      ['fe:src/components/SessionInfo.tsx#SessionInfo', 'http', 'endpoint:next:GET /api/session'],
      ['endpoint:next:GET /api/session', 'handles', 'fe:src/app/api/session/route.ts#GET'],
      ['fe:src/app/api/session/route.ts#GET', 'http', 'endpoint:laravel:GET /api/me'],
      ['endpoint:laravel:GET /api/me', 'handles', 'be:App\\Http\\Controllers\\AuthController::me'],
      ['fe:src/app/page.tsx#getGreeting', 'http', 'endpoint:next:ANY /api/hello'],
      // Relative URL with no Next.js handler: Laravel, uncertain.
      ['fe:src/hooks/useMe.ts#useMe', 'http', 'endpoint:laravel:GET /api/me', false],
      // Unknown base URL: static suffix match, uncertain.
      ['fe:src/lib/fetcher.ts#getPostsFrom', 'http', 'endpoint:laravel:GET /api/v1/posts', false],
    ]);
  });

  it('covers every route action style', () => {
    expectChain([
      ['fe:src/components/StatusBadge.tsx#StatusBadge', 'http', 'endpoint:laravel:GET /api/ping'],
      ['endpoint:laravel:GET /api/ping', 'handles', 'be:routes/api.php#closure@11'],
      ['endpoint:laravel:GET /api/health', 'handles', 'be:App\\Http\\Controllers\\HealthCheckController::__invoke'],
      ['fe:src/app/(auth)/login/page.tsx#LoginPage', 'http', 'endpoint:laravel:POST /api/login'],
      ['fe:src/app/(auth)/login/page.tsx#LoginPage', 'calls', 'fe:src/lib/users.ts#logout'],
      ['fe:src/lib/users.ts#logout', 'http', 'endpoint:laravel:POST /logout'],
      ['endpoint:laravel:POST /logout', 'handles', 'be:App\\Http\\Controllers\\AuthController::logout'],
      ['fe:src/app/admin/reports/page.tsx#ReportsPage', 'http', 'endpoint:laravel:POST /api/v1/admin/reports/export'],
      ['fe:src/app/posts/[id]/page.tsx#PostPage', 'calls', 'fe:src/lib/posts.ts#postsApi.get'],
      ['fe:src/lib/posts.ts#postsApi.list', 'http', 'endpoint:laravel:GET /api/v1/posts'],
    ]);
  });

  it('lists unmatched endpoints and unmatched HTTP calls', () => {
    expect(graph.unmatched.endpoints).toEqual(['endpoint:laravel:DELETE /api/v1/posts/*', 'endpoint:laravel:GET /']);
    expect(graph.unmatched.httpCalls.map((c) => `${c.target} | ${c.file}:${c.line} | ${c.reason}`)).toEqual([
      'unmatched:POST /api/v1/analytics | src/components/Analytics.tsx:6 | no Laravel route matches',
      'unmatched:dynamic | src/lib/fetcher.ts:2 | dynamic URL',
    ]);
    // Unmatched calls stay visible as nodes in the middle column.
    expect(graph.nodes.find((n) => n.id === 'unmatched:POST /api/v1/analytics')).toMatchObject({ kind: 'unmatched' });
  });

  it('words unmatched calls for the sides that were analyzed', () => {
    // Frontend only: a backend call has nothing to match, which is not the same as "no Laravel route matches".
    const fe = analyze({ backend: null, frontend: path.join(root, 'next-web'), config: defaultConfig() }).graph;
    expect(fe.unmatched.httpCalls.find((c) => c.target === 'unmatched:POST /api/v1/analytics')?.reason).toBe('calls the backend, which was not analyzed (no --backend)');
    expect(fe.unmatched.httpCalls.some((c) => /Laravel/.test(c.reason))).toBe(false);
    // Backend only: no frontend could call the routes, so none is listed as never called.
    const be = analyze({ backend: path.join(root, 'laravel-api'), frontend: null, config: defaultConfig() }).graph;
    expect(be.unmatched.endpoints).toEqual([]);
    expect(be.meta.stats.unmatchedEndpoints).toBe(0);
  });

  it('resolves PHP use statements, constructor-promoted properties and uncertain $this calls', () => {
    expectChain([
      ['be:app/Http/Controllers/UserController.php', 'uses', 'be:App\\Services\\UserService'],
      ['be:App\\Http\\Controllers\\UserController', 'uses', 'be:App\\Http\\Controllers\\Controller'],
      ['be:App\\Http\\Controllers\\UserController::store', 'calls', 'be:App\\Http\\Requests\\StoreUserRequest'],
      ['be:App\\Http\\Controllers\\UserController::authorizeCreate', 'calls', 'be:App\\Http\\Controllers\\UserController', false],
      ['be:App\\Http\\Controllers\\Admin\\ReportController::export', 'calls', 'be:App\\Services\\ReportService'],
    ]);
  });

  it('labels files with roles and Next.js conventions', () => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('be:app/Http/Controllers/UserController.php')?.role).toBe('controller');
    expect(byId.get('be:app/Models/User.php')?.role).toBe('model');
    expect(byId.get('be:app/Services/UserService.php')?.role).toBe('service');
    expect(byId.get('be:app/Http/Requests/StoreUserRequest.php')?.role).toBe('request');
    expect(byId.get('be:app/Http/Middleware/EnsureJsonResponse.php')?.role).toBe('middleware');
    expect(byId.get('fe:src/app/(dashboard)/users/[id]/page.tsx')).toMatchObject({ nextKind: 'page', route: '/users/[id]' });
    expect(byId.get('fe:src/app/api/session/route.ts')).toMatchObject({ nextKind: 'route', route: '/api/session' });
    expect(byId.get('fe:src/components/PostEditor.tsx')?.client).toBe(true);
    expect(byId.get('fe:src/components/UserList.tsx#UserList')?.component).toBe(true);
    expect(byId.get('be:App\\Http\\Controllers\\UserController::show')).toMatchObject({
      kind: 'method',
      file: 'app/Http/Controllers/UserController.php',
      line: 20,
      parent: 'be:App\\Http\\Controllers\\UserController',
      visibility: 'public',
    });
  });

  it('is deterministic', () => {
    const again = run();
    expect(JSON.stringify(again.nodes)).toBe(JSON.stringify(graph.nodes));
    expect(JSON.stringify(again.edges)).toBe(JSON.stringify(graph.edges));
    expect(again.meta.stats).toEqual(graph.meta.stats);
  });
});
