import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { defaultConfig, type SecurityOptions } from '../src/config.js';
import { collectFileScope } from '../src/lang/php/names.js';
import { extractRoutes } from '../src/lang/php/routes.js';
import { parseSource } from '../src/parse.js';
import { scanChecks } from '../src/security/code.js';
import { buildRegistry } from '../src/security/registry.js';
import type { SecurityReport } from '../src/security/types.js';

const fixtures = path.resolve(__dirname, '..', 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seammap-sec-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** "METHOD /uri: mw1, mw2 [-excluded] (loader)" per route. */
function routeMiddleware(files: Record<string, string>): string[] {
  const trees = new Map(Object.entries(files).map(([rel, src]) => [rel, parseSource('php', src).rootNode]));
  const ex = extractRoutes(trees, { controllerNamespace: 'App\\Http\\Controllers', apiPrefix: '/api' });
  return ex.routes.map((r) => {
    const ex = r.excludedMiddleware.map((m) => ` -${m.name}`).join('');
    return `${r.methods.join('|')} ${r.uri}: ${r.middleware.map((m) => `${m.name}@${m.via}`).join(', ')}${ex} (${r.loader})`;
  });
}

function security(backend: string, options: Partial<SecurityOptions> = {}): SecurityReport {
  const config = defaultConfig();
  Object.assign(config.security, options);
  return analyze({ backend, frontend: null, config, security: true }).graph.security!;
}

const states = (report: SecurityReport) => Object.fromEntries(report.endpoints.map((e) => [e.id.replace('endpoint:laravel:', ''), e.state]));

describe('route middleware capture', () => {
  it('records middleware before and after the verb, on groups, arrays and resources', () => {
    expect(
      routeMiddleware({
        'routes/web.php': `<?php
use App\\Http\\Middleware\\Tenant;
use Illuminate\\Support\\Facades\\Route;
Route::middleware('auth')->get('/a', fn () => 1);
Route::get('/b', fn () => 1)->middleware(['auth:sanctum', 'verified'])->name('b');
Route::get('/c', fn () => 1)->middleware(Tenant::class.':acme')->can('view', 'post');
Route::middleware(['auth'])->prefix('x')->group(function () {
    Route::group(['middleware' => 'throttle:6,1', 'excluded_middleware' => ['auth']], function () {
        Route::post('/d', fn () => 1)->withoutMiddleware('throttle:6,1');
    });
});
Route::resource('posts', 'PostController')->only(['index', 'store'])->middlewareFor('store', 'can:create,App\\Models\\Post');
`,
      }),
    ).toEqual([
      'GET /a: web@loader, auth@route (convention)',
      'GET /b: web@loader, auth:sanctum@route, verified@route (convention)',
      'GET /c: web@loader, App\\Http\\Middleware\\Tenant:acme@route, can:view,post@route (convention)',
      'POST /x/d: web@loader, auth@group, throttle:6,1@group -auth -throttle:6,1 (convention)',
      'GET /posts: web@loader (convention)',
      'POST /posts: web@loader, can:create,App\\Models\\Post@resource (convention)',
    ]);
  });

  it('uses bootstrap/app.php withRouting groups, provider chains, and marks unknown loaders', () => {
    expect(
      routeMiddleware({
        'bootstrap/app.php': `<?php
use Illuminate\\Support\\Facades\\Route;
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        then: function () {
            Route::middleware(['api', 'auth:sanctum'])->prefix('hooks')->group(base_path('routes/hooks.php'));
        },
    )->create();`,
        'routes/web.php': `<?php Route::get('/', fn () => 1);`,
        'routes/api.php': `<?php Route::get('/me', fn () => 1);`,
        'routes/hooks.php': `<?php Route::post('/stripe', fn () => 1);`,
        'routes/legacy.php': `<?php Route::get('/old', fn () => 1);`,
      }),
    ).toEqual([
      'POST /hooks/stripe: api@group, auth:sanctum@group (seen)',
      'GET /api/me: api@loader (seen)',
      'GET /old:  (unknown)',
      'GET /: web@loader (seen)',
    ]);
  });

  it('keeps non-literal middleware as null instead of guessing', () => {
    expect(routeMiddleware({ 'routes/web.php': `<?php Route::get('/a', fn () => 1)->middleware($mw);` })).toEqual(['GET /a: web@loader, null@route (convention)']);
  });
});

describe('middleware registry', () => {
  const reg = (files: Record<string, string>, bootstrap?: string) =>
    buildRegistry(
      new Map(Object.entries(files).map(([rel, source]) => [rel, { root: parseSource('php', source).rootNode, source }])),
      bootstrap ? parseSource('php', bootstrap).rootNode : null,
    );

  it('reads Laravel <= 10 Kernel.php aliases, groups and global middleware', () => {
    const r = reg({
      'app/Http/Kernel.php': `<?php
namespace App\\Http;
use Illuminate\\Foundation\\Http\\Kernel as HttpKernel;
class Kernel extends HttpKernel
{
    protected $middleware = [\\App\\Http\\Middleware\\TrustProxies::class];
    protected $middlewareGroups = [
        'web' => [\\App\\Http\\Middleware\\EncryptCookies::class, \\Illuminate\\Session\\Middleware\\StartSession::class],
        'api' => ['throttle:api', \\Illuminate\\Routing\\Middleware\\SubstituteBindings::class],
    ];
    protected $middlewareAliases = [
        'auth' => \\App\\Http\\Middleware\\Authenticate::class,
        'role' => \\Spatie\\Permission\\Middleware\\RoleMiddleware::class,
    ];
}`,
    });
    expect(r.hasKernel).toBe(true);
    expect(r.global.map((m) => m.name)).toEqual(['App\\Http\\Middleware\\TrustProxies']);
    expect(r.groups.get('api')?.members.map((m) => m.name)).toEqual(['throttle:api', 'Illuminate\\Routing\\Middleware\\SubstituteBindings']);
    expect(r.aliases.get('role')?.target).toBe('Spatie\\Permission\\Middleware\\RoleMiddleware');
    expect(r.aliases.get('auth')?.source).toMatch(/^app\/Http\/Kernel\.php:\d+$/);
  });

  it('applies bootstrap/app.php withMiddleware() edits in Laravel order', () => {
    const r = reg(
      {
        'app/Providers/AppServiceProvider.php': `<?php
namespace App\\Providers;
class AppServiceProvider { public function boot($router) { $router->aliasMiddleware('tenant', \\App\\Http\\Middleware\\Tenant::class); } }`,
      },
      `<?php
use App\\Http\\Middleware\\Locale;
return Application::configure(basePath: dirname(__DIR__))
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->alias(['admin' => \\App\\Http\\Middleware\\Admin::class]);
        $middleware->web(append: [Locale::class], remove: [\\Illuminate\\Session\\Middleware\\StartSession::class]);
        $middleware->statefulApi();
        $middleware->appendToGroup('partner', ['auth:sanctum']);
        $middleware->prependToGroup('partner', 'throttle:60,1');
        $middleware->append(\\App\\Http\\Middleware\\Audit::class);
    })->create();`,
    );
    expect(r.hasKernel).toBe(false);
    expect(r.aliases.get('admin')?.target).toBe('App\\Http\\Middleware\\Admin');
    expect(r.aliases.get('tenant')?.target).toBe('App\\Http\\Middleware\\Tenant');
    const web = r.groups.get('web')!.members.map((m) => m.name);
    expect(web).not.toContain('Illuminate\\Session\\Middleware\\StartSession');
    expect(web.at(-1)).toBe('App\\Http\\Middleware\\Locale');
    expect(r.groups.get('api')!.members[0].name).toBe('Laravel\\Sanctum\\Http\\Middleware\\EnsureFrontendRequestsAreStateful');
    expect(r.groups.get('partner')!.members.map((m) => m.name)).toEqual(['throttle:60,1', 'auth:sanctum']);
    expect(r.global.at(-1)?.name).toBe('App\\Http\\Middleware\\Audit');
  });
});

describe('access checks in handler code', () => {
  const checks = (body: string) => {
    const root = parseSource('php', `<?php\nuse Illuminate\\Support\\Facades\\Gate;\nfunction h($request, $post) {\n${body}\n}`).rootNode;
    const fn = root.descendantsOfType('function_definition')[0];
    return scanChecks(fn.childForFieldName('body')!, collectFileScope(root), 'x.php').map((c) => `${c.kind}: ${c.text}`);
  };

  it('tells throwing, enforced, conditional and login checks apart', () => {
    expect(
      checks(`
$this->authorize('update', $post);
abort_unless($request->user()->can('edit', $post), 403);
if (Gate::denies('delete', $post)) {
    abort(403);
}
$showDrafts = $request->user()?->can('see-drafts');
if (auth()->check()) { $x = 1; }`),
    ).toEqual([
      "throwing: $this->authorize('update', $post)",
      "enforced: $request->user()->can('edit', $post)",
      "enforced: Gate::denies('delete', $post)",
      "conditional: $request->user()?->can('see-drafts')",
      'login: auth()->check()',
    ]);
  });
});

describe('security lens on fixtures/laravel-security', () => {
  const report = security(path.join(fixtures, 'laravel-security'));

  it('classifies every case as the route file comments say', () => {
    expect(states(report)).toEqual({
      'DELETE /api/projects/*': 'authorization',
      'GET /': 'none',
      'GET /api/account': 'authenticated',
      'GET /api/avatars/*': 'none',
      'GET /api/billing/between': 'authenticated',
      'GET /api/billing/search': 'authenticated',
      'GET /api/billing/sorted': 'authenticated',
      'GET /api/exports': 'authenticated',
      'GET /api/invoices': 'authorization',
      'GET /api/invoices/*': 'authorization',
      'GET /api/invoices/*/pdf': 'authenticated',
      'GET /api/json-only': 'unknown',
      'GET /api/projects': 'none',
      'GET /api/report-cards': 'authorization',
      'GET /api/report-cards/preview': 'none',
      'GET /api/reports/public': 'unknown',
      'GET /api/status': 'none',
      'GET /api/teams': 'authorization',
      'GET /api/tenant/settings': 'unknown',
      'GET /api/unsubscribe/*': 'signed',
      'GET /dashboard': 'authenticated',
      'GET /legacy/ping': 'unknown',
      'GET /partner-api/feed': 'authenticated',
      'GET /partner-api/orders': 'authenticated',
      'POST /api/account/ping': 'none',
      'POST /api/billing/invoices': 'authenticated',
      'POST /api/billing/register': 'none',
      'POST /api/billing/users/*/restore': 'authenticated',
      'POST /api/feedback': 'none',
      'POST /api/projects': 'authorization',
      'POST /api/signup': 'public',
      'POST /api/teams/export': 'authenticated',
      'PUT /api/account': 'authorization',
      'PUT /api/billing/invoices/*': 'authenticated',
    });
  });

  it('explains states with signals, confidence, notes and review flags', () => {
    const ep = (id: string) => report.endpoints.find((e) => e.id === `endpoint:laravel:${id}`)!;
    expect(ep('GET /api/invoices').signals.map((s) => `${s.effect} ${s.source} ${s.text}`)).toEqual([
      'authentication controller auth:sanctum',
      'authorization controller can:view-invoices',
    ]);
    expect(ep('DELETE /api/projects/*')).toMatchObject({ confidence: 'medium' });
    expect(ep('POST /api/projects').reason).toBe('StoreProjectRequest::authorize() (FormRequest)');
    expect(ep('POST /api/feedback').notes.join('\n')).toMatch(/FeedbackRequest::authorize\(\) always returns true/);
    expect(ep('POST /api/feedback').review).toContain('state-changing, no protection found');
    expect(ep('GET /api/avatars/*').notes.join('\n')).toMatch(/auth:sanctum: removed by withoutMiddleware/);
    expect(ep('GET /legacy/ping').unknown).toEqual(['unknown-loader']);
    expect(ep('GET /api/report-cards').signals.map((s) => s.text)).toEqual(['#[Middleware(auth:sanctum)]', '#[Authorize(view-report-cards)]']);
    expect(ep('GET /api/report-cards/preview').notes.join('\n')).toMatch(/#\[WithoutMiddleware\(auth:sanctum\)\]/);
    expect(ep('GET /api/teams').notes.join('\n')).toMatch(/admin\.only/);
  });

  it('summarizes states, unknown reasons and unresolved middleware with hints', () => {
    expect(report.summary).toEqual({ authorization: 7, authenticated: 13, signed: 1, public: 1, unknown: 4, none: 8 });
    expect(report.unknownReasons.map((r) => r.reason).sort()).toEqual(['check-in-code', 'custom-middleware', 'undefined-alias', 'unknown-loader']);
    const json = report.middleware.unresolved.find((u) => u.name === 'App\\Http\\Middleware\\EnsureJsonResponse')!;
    expect(json).toMatchObject({ decisive: 1 });
    expect(json.hint).toMatch(/ignoreMiddleware/);
    expect(report.middleware.unresolved.find((u) => u.name === 'App\\Http\\Middleware\\EnsureAdmin')?.hint).toMatch(/authorization/);
    expect(report.caveats.join('\n')).toMatch(/laravel\/sanctum/);
    expect(report.notChecked.length).toBeGreaterThan(5);
  });

  it('lets security config classify custom middleware', () => {
    const s = states(
      security(path.join(fixtures, 'laravel-security'), {
        ignoreMiddleware: ['App\\Http\\Middleware\\EnsureJsonResponse'],
        authMiddleware: ['tenant'],
        authorizationMiddleware: ['admin.only'],
      }),
    );
    expect(s['GET /api/json-only']).toBe('none');
    expect(s['GET /api/tenant/settings']).toBe('authenticated');
    expect(s['POST /api/teams/export']).toBe('authorization');
  });
});

describe('security lens on a Laravel 10 style app', () => {
  const root = path.join(tmp, 'l10');
  write(root, {
    'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
    artisan: '',
    'app/Http/Kernel.php': `<?php
namespace App\\Http;
use Illuminate\\Foundation\\Http\\Kernel as HttpKernel;
class Kernel extends HttpKernel
{
    protected $middlewareGroups = [
        'web' => [\\Illuminate\\Session\\Middleware\\StartSession::class],
        'api' => [\\Illuminate\\Routing\\Middleware\\SubstituteBindings::class],
    ];
    protected $routeMiddleware = [
        'auth' => \\App\\Http\\Middleware\\Authenticate::class,
        'guest' => \\App\\Http\\Middleware\\RedirectIfAuthenticated::class,
    ];
}`,
    'app/Http/Middleware/Authenticate.php': `<?php
namespace App\\Http\\Middleware;
use Illuminate\\Auth\\Middleware\\Authenticate as Middleware;
class Authenticate extends Middleware {}`,
    'app/Http/Middleware/RedirectIfAuthenticated.php': `<?php
namespace App\\Http\\Middleware;
class RedirectIfAuthenticated { public function handle($request, $next) { return $next($request); } }`,
    'app/Providers/RouteServiceProvider.php': `<?php
namespace App\\Providers;
use Illuminate\\Support\\Facades\\Route;
class RouteServiceProvider
{
    public function boot()
    {
        $this->routes(function () {
            Route::middleware('api')->prefix('api')->group(base_path('routes/api.php'));
            Route::middleware('web')->group(base_path('routes/web.php'));
        });
    }
}`,
    'app/Http/Controllers/Controller.php': `<?php
namespace App\\Http\\Controllers;
use Illuminate\\Routing\\Controller as BaseController;
class Controller extends BaseController
{
    public function __construct()
    {
        $this->middleware('auth')->except(['login']);
    }
}`,
    'app/Http/Controllers/AccountController.php': `<?php
namespace App\\Http\\Controllers;
class AccountController extends Controller
{
    public function login() { return 1; }
    public function show() { return 1; }
}`,
    'app/Http/Controllers/ReportController.php': `<?php
namespace App\\Http\\Controllers;
class ReportController extends Controller
{
    public function __construct()
    {
        parent::__construct();
        $this->middleware(function ($request, $next) { return $next($request); });
    }
    public function index() { return 1; }
}`,
    'routes/api.php': `<?php
use App\\Http\\Controllers\\AccountController;
use App\\Http\\Controllers\\ReportController;
use Illuminate\\Support\\Facades\\Route;
Route::get('/login', [AccountController::class, 'login'])->middleware('guest');
Route::get('/account', [AccountController::class, 'show']);
Route::get('/reports', [ReportController::class, 'index']);
`,
    'routes/web.php': `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/', fn () => 'home');
`,
  });

  it('follows Kernel aliases, provider-loaded groups and inherited constructor middleware', () => {
    const report = security(root);
    expect(states(report)).toEqual({
      'GET /': 'none',
      'GET /api/account': 'authenticated',
      'GET /api/login': 'public',
      'GET /api/reports': 'authenticated',
    });
    const reports = report.endpoints.find((e) => e.id.endsWith('/api/reports'))!;
    expect(reports.middleware.join(' | ')).toMatch(/inherited from Controller/);
    expect(reports.notes.join('\n')).toMatch(/closure/);
    const account = report.endpoints.find((e) => e.id.endsWith('/api/account'))!;
    expect(account.signals[0].detail).toMatch(/Authenticate extends Illuminate\\Auth\\Middleware\\Authenticate/);
  });
});

describe('flag off', () => {
  it('leaves graph.json without security data and with the same nodes and edges', () => {
    const opts = { backend: path.join(fixtures, 'laravel-api'), frontend: path.join(fixtures, 'next-web') };
    const off = analyze({ ...opts, config: defaultConfig() }).graph;
    const on = analyze({ ...opts, config: defaultConfig(), security: true }).graph;
    expect(off.security).toBeUndefined();
    expect('security' in off.meta.timings).toBe(false);
    expect(on.security).toBeDefined();
    expect(on.meta.timings.security).toBeTypeOf('number');
    // With the lens, definitions also carry their end line; nothing else differs.
    expect(off.nodes.some((n) => 'endLine' in n)).toBe(false);
    expect(on.nodes.find((n) => n.id === 'be:App\\Http\\Controllers\\UserController::store')?.endLine).toBeGreaterThan(on.nodes.find((n) => n.id === 'be:App\\Http\\Controllers\\UserController::store')!.line!);
    expect(JSON.stringify(on.nodes.map(({ endLine: _, ...n }) => n))).toBe(JSON.stringify(off.nodes));
    expect(JSON.stringify(on.edges)).toBe(JSON.stringify(off.edges));
    expect(on.meta.stats).toEqual(off.meta.stats);
  });

  it('produces stable output across runs', () => {
    const backend = path.join(fixtures, 'laravel-security');
    expect(JSON.stringify(security(backend))).toBe(JSON.stringify(security(backend)));
  });
});
