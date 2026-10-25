import { describe, expect, it } from 'vitest';
import { extractRoutes, singular } from '../src/lang/php/routes.js';
import { parseSource } from '../src/parse.js';

/**
 * Extract routes from inline route files; returns "METHODS /uri -> Controller@method" lines.
 * Only the most likely controller candidate is shown unless `allCandidates` is set.
 */
function routes(files: Record<string, string>, apiPrefix = '/api', allCandidates = false): string[] {
  const trees = new Map(Object.entries(files).map(([rel, src]) => [rel, parseSource('php', src).rootNode]));
  const ex = extractRoutes(trees, { controllerNamespace: 'App\\Http\\Controllers', apiPrefix });
  return ex.routes.map((r) => {
    const a = r.action;
    const classes = a.type === 'controller' ? (allCandidates ? a.classes.join(' | ') : a.classes[0]) : '';
    const target = a.type === 'controller' ? `${classes}@${a.method}` : a.type === 'closure' ? `closure@${a.line}` : `? ${a.text}`;
    return `${r.methods.join('|')} ${r.uri} -> ${target}`;
  });
}

const header = `<?php
use App\\Http\\Controllers\\UserController;
use App\\Http\\Controllers\\PostController;
use Illuminate\\Support\\Facades\\Route;
`;

describe('Laravel routes', () => {
  it('handles verbs, match/any, action styles and the api prefix', () => {
    expect(
      routes({
        'routes/api.php': `${header}
Route::get('/users', [UserController::class, 'index'])->name('users.index');
Route::post('users', 'UserController@store');
Route::get('/stats', \\App\\Http\\Controllers\\StatsController::class);
Route::match(['put', 'PATCH'], '/users/{user}', [UserController::class, 'update']);
Route::any('/hook', 'HookController@handle');
Route::get('/ping', function () { return 'pong'; });
Route::get('/fn', fn () => 1);
Route::middleware('auth:sanctum')->get('/me', [UserController::class, 'me']);
Route::view('/welcome', 'welcome');
Route::redirect('/old', '/new');
Route::fallback(fn () => 404);`,
      }),
    ).toEqual([
      'GET /api/users -> App\\Http\\Controllers\\UserController@index',
      'POST /api/users -> App\\Http\\Controllers\\UserController@store',
      'GET /api/stats -> App\\Http\\Controllers\\StatsController@__invoke',
      'PATCH|PUT /api/users/{user} -> App\\Http\\Controllers\\UserController@update',
      'ANY /api/hook -> App\\Http\\Controllers\\HookController@handle',
      'GET /api/ping -> closure@11',
      'GET /api/fn -> closure@12',
      'GET /api/me -> App\\Http\\Controllers\\UserController@me',
    ]);
  });

  it('applies prefixes cumulatively through groups and chained attributes', () => {
    expect(
      routes({
        'routes/api.php': `${header}
Route::prefix('v1')->middleware('auth')->group(function () {
    Route::get('/a', [UserController::class, 'a']);
    Route::group(['prefix' => 'admin', 'middleware' => 'x'], function () {
        Route::prefix('deep')->group(fn () => Route::get('b', [UserController::class, 'b']));
    });
    Route::controller(PostController::class)->prefix('posts')->group(function () {
        Route::get('/', 'index');
        Route::post('/{post}/publish', 'publish');
    });
});`,
        'routes/web.php': `${header}
Route::get('/', [UserController::class, 'home']);`,
      }),
    ).toEqual([
      'GET /api/v1/a -> App\\Http\\Controllers\\UserController@a',
      'GET /api/v1/admin/deep/b -> App\\Http\\Controllers\\UserController@b',
      'GET /api/v1/posts -> App\\Http\\Controllers\\PostController@index',
      'POST /api/v1/posts/{post}/publish -> App\\Http\\Controllers\\PostController@publish',
      'GET / -> App\\Http\\Controllers\\UserController@home',
    ]);
  });

  it('expands resource and apiResource with only/except and nested names', () => {
    expect(
      routes({
        'routes/api.php': `${header}
Route::apiResource('users', UserController::class)->only(['index', 'show']);
Route::apiResource('photos', PhotoController::class)->except('destroy');
Route::resource('posts.comments', CommentController::class, ['only' => ['index', 'edit']]);`,
      }),
    ).toEqual([
      'GET /api/users -> App\\Http\\Controllers\\UserController@index',
      'GET /api/users/{user} -> App\\Http\\Controllers\\UserController@show',
      'GET /api/photos -> App\\Http\\Controllers\\PhotoController@index',
      'POST /api/photos -> App\\Http\\Controllers\\PhotoController@store',
      'GET /api/photos/{photo} -> App\\Http\\Controllers\\PhotoController@show',
      'PATCH|PUT /api/photos/{photo} -> App\\Http\\Controllers\\PhotoController@update',
      'GET /api/posts/{post}/comments -> App\\Http\\Controllers\\CommentController@index',
      'GET /api/posts/{post}/comments/{comment}/edit -> App\\Http\\Controllers\\CommentController@edit',
    ]);
  });

  it('expands a full resource in Laravel order', () => {
    const r = routes({ 'routes/web.php': `${header}\nRoute::resource('categories', CategoryController::class);` });
    expect(r.map((x) => x.split(' -> ')[0])).toEqual([
      'GET /categories',
      'GET /categories/create',
      'POST /categories',
      'GET /categories/{category}',
      'GET /categories/{category}/edit',
      'PATCH|PUT /categories/{category}',
      'DELETE /categories/{category}',
    ]);
  });

  it('inherits the prefix of the including group for required route files', () => {
    expect(
      routes({
        'routes/api.php': `${header}
Route::prefix('v2')->group(function () {
    require __DIR__.'/admin.php';
});
Route::prefix('billing')->group(base_path('routes/billing.php'));`,
        'routes/admin.php': `${header}\nRoute::get('/stats', [UserController::class, 'stats']);`,
        'routes/billing.php': `${header}\nRoute::get('/plans', [UserController::class, 'plans']);`,
      }),
    ).toEqual([
      'GET /api/v2/stats -> App\\Http\\Controllers\\UserController@stats',
      'GET /api/billing/plans -> App\\Http\\Controllers\\UserController@plans',
    ]);
  });

  it('follows RouteServiceProvider registrations (Laravel <= 10)', () => {
    expect(
      routes({
        'app/Providers/RouteServiceProvider.php': `<?php
namespace App\\Providers;
use Illuminate\\Support\\Facades\\Route;
class RouteServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $this->routes(function () {
            Route::middleware('api')->prefix('api/v2')->group(base_path('routes/api.php'));
            Route::middleware('web')->group(base_path('routes/web.php'));
        });
    }
}`,
        'routes/api.php': `${header}\nRoute::get('/users', [UserController::class, 'index']);`,
        'routes/web.php': `${header}\nRoute::get('/', [UserController::class, 'home']);`,
      }),
    ).toEqual(['GET /api/v2/users -> App\\Http\\Controllers\\UserController@index', 'GET / -> App\\Http\\Controllers\\UserController@home']);
  });

  it('keeps both readings of a group namespace (relative or absolute)', () => {
    expect(
      routes(
        {
          'routes/web.php': `<?php
Route::group(['namespace' => 'Admin'], function () {
    Route::get('/a', 'ReportController@index');
});
Route::group(['namespace' => '\\Vendor\\Http'], function () {
    Route::get('/b', ['uses' => 'HookController@run', 'as' => 'b']);
});`,
        },
        '/api',
        true,
      ),
    ).toEqual([
      // Relative to App\\Http\\Controllers (Laravel <= 7 default), absolute, or global.
      'GET /a -> App\\Http\\Controllers\\Admin\\ReportController | Admin\\ReportController | ReportController@index',
      'GET /b -> Vendor\\Http\\HookController | HookController@run',
    ]);
  });

  it('honours a custom api prefix (config or bootstrap/app.php apiPrefix)', () => {
    expect(routes({ 'routes/api.php': `${header}\nRoute::get('/x', [UserController::class, 'x']);` }, '/api/v9')).toEqual([
      'GET /api/v9/x -> App\\Http\\Controllers\\UserController@x',
    ]);
  });

  it('singularizes resource parameter names', () => {
    expect(['users', 'categories', 'boxes', 'status', 'news'].map(singular)).toEqual(['user', 'category', 'box', 'status', 'new']);
  });
});
