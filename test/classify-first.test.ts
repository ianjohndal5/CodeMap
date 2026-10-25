import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { defaultConfig } from '../src/config.js';

// A small Laravel app where two custom middleware keep three endpoints unknown.
const app = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-classify-'));
afterAll(() => fs.rmSync(app, { recursive: true, force: true }));
const files: Record<string, string> = {
  'composer.json': '{ "autoload": { "psr-4": { "App\\\\": "app/" } } }',
  artisan: '',
  'bootstrap/app.php': `<?php
use Illuminate\\Foundation\\Application;
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(api: __DIR__.'/../routes/api.php')
    ->create();
`,
  'app/Http/Middleware/Tenant.php': `<?php
namespace App\\Http\\Middleware;
class Tenant { public function handle($request, $next) { return $next($request); } }
`,
  'app/Http/Middleware/Audit.php': `<?php
namespace App\\Http\\Middleware;
class Audit { public function handle($request, $next) { return $next($request); } }
`,
  'app/Http/Controllers/ItemController.php': `<?php
namespace App\\Http\\Controllers;
class ItemController { public function index() {} public function store() {} public function show($id) {} }
`,
  'routes/api.php': `<?php
use App\\Http\\Controllers\\ItemController;
use App\\Http\\Middleware\\Audit;
use App\\Http\\Middleware\\Tenant;
use Illuminate\\Support\\Facades\\Route;

Route::middleware([Tenant::class])->group(function () {
    Route::get('/items', [ItemController::class, 'index']);
    Route::post('/items', [ItemController::class, 'store']);
    Route::middleware([Audit::class])->get('/items/{id}', [ItemController::class, 'show']);
});
Route::get('/ping', fn () => 'ok');
`,
};
for (const [rel, content] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
  fs.writeFileSync(path.join(app, rel), content);
}

const security = (ignore: string[] = []) => {
  const config = defaultConfig();
  config.security.ignoreMiddleware.push(...ignore);
  return analyze({ backend: app, frontend: null, config, security: true }).graph.security!;
};

describe('classifyFirst', () => {
  it('names the few middleware that keep most unknown endpoints unknown', () => {
    const sec = security();
    expect(sec.summary.unknown).toBe(3);
    // Tenant alone settles two endpoints; with Audit, the third (which carries both) too.
    expect(sec.classifyFirst).toEqual({ middleware: ['App\\Http\\Middleware\\Tenant', 'App\\Http\\Middleware\\Audit'], endpoints: 3 });
  });

  it('resolves exactly as many endpoints as it says, once the user classifies them', () => {
    const before = security();
    const after = security(before.classifyFirst!.middleware);
    expect(before.summary.unknown - after.summary.unknown).toBe(before.classifyFirst!.endpoints);
    expect(after.classifyFirst).toBeNull();
  });

  it('never changes a state by itself', () => {
    const states = security().endpoints.map((e) => [e.id, e.state]);
    expect(Object.fromEntries(states)).toMatchObject({
      'endpoint:laravel:GET /api/items': 'unknown',
      'endpoint:laravel:GET /api/ping': 'none',
    });
  });

  it('is null when no small set settles a majority of the unknowns', () => {
    const fixtures = path.resolve(__dirname, '..', 'fixtures');
    const sec = analyze({ backend: path.join(fixtures, 'laravel-security'), frontend: null, config: defaultConfig(), security: true }).graph.security!;
    expect(sec.summary.unknown).toBeGreaterThan(0);
    expect(sec.classifyFirst).toBeNull();
  });
});
