<?php

use App\Http\Controllers\AccountController;
use App\Http\Controllers\BillingController;
use App\Http\Controllers\InvoiceController;
use App\Http\Controllers\ProjectController;
use App\Http\Controllers\ReportCardController;
use App\Http\Controllers\TeamController;
use App\Http\Middleware\EnsureJsonResponse;
use Illuminate\Support\Facades\Route;

// Security lens cases. The comment above each route is the expected state.

// public: guest middleware before the verb.
Route::middleware('guest')->post('/signup', [AccountController::class, 'signup']);

// none: only the api group (no access middleware).
Route::get('/status', [AccountController::class, 'status']);

// signed: middleware after the verb.
Route::get('/unsubscribe/{user}', [AccountController::class, 'unsubscribe'])->name('unsubscribe')->middleware('signed');

// none, with a note: FeedbackRequest::authorize() returns a literal true.
Route::post('/feedback', [AccountController::class, 'feedback']);

// unknown: alias 'tenant' is not defined anywhere CodeMap reads.
Route::get('/tenant/settings', [AccountController::class, 'settings'])->middleware('tenant');

// unknown: project middleware CodeMap does not classify (resolvable with security.ignoreMiddleware).
Route::get('/json-only', [AccountController::class, 'status'])->middleware(EnsureJsonResponse::class);

// unknown: a ->can() check in code whose effect is not evaluated.
Route::get('/reports/public', [AccountController::class, 'publicReport']);

Route::middleware(['auth:sanctum', 'throttle:60,1'])->group(function () {
    // authenticated: array option on the group.
    Route::get('/account', [AccountController::class, 'show']);

    // authorization: ->can() on the route.
    Route::put('/account', [AccountController::class, 'update'])->can('update-account');

    // none: withoutMiddleware removes the group's auth.
    Route::post('/account/ping', [AccountController::class, 'ping'])->withoutMiddleware('auth:sanctum');

    // none: excluded_middleware on a nested group.
    Route::group(['excluded_middleware' => ['auth:sanctum']], function () {
        Route::get('/avatars/{user}', [AccountController::class, 'avatar']);
    });

    Route::prefix('teams')->middleware('admin.only')->group(function () {
        // authorization: authorizeResource() in TeamController (index -> can:viewAny).
        Route::get('/', [TeamController::class, 'index']);
        // authenticated: not a resource method; admin.only (custom) stays listed as unresolved.
        Route::post('/export', [TeamController::class, 'export']);
    });
});

// Constructor middleware: auth except index, throttle only on store.
// none (index) / authorization via StoreProjectRequest (store) / authorization via $this->authorize (destroy).
Route::get('/projects', [ProjectController::class, 'index']);
Route::post('/projects', [ProjectController::class, 'store']);
Route::delete('/projects/{project}', [ProjectController::class, 'destroy']);

// HasMiddleware (Laravel 11+): auth:sanctum everywhere, can:view-invoices only on index.
// authorization (index) / authorization via Gate::denies + abort (show) / authenticated (pdf: Auth::check() is display logic).
Route::get('/invoices', [InvoiceController::class, 'index']);
Route::get('/invoices/{invoice}', [InvoiceController::class, 'show']);
Route::get('/invoices/{invoice}/pdf', [InvoiceController::class, 'pdf']);

// authenticated: Laravel 13 #[Middleware] attribute on the action (constructor auth skips it).
Route::get('/exports', [ProjectController::class, 'exports']);

// Laravel 13 attributes: class #[Middleware] + method #[Authorize] (authorization) / #[WithoutMiddleware] (none).
Route::get('/report-cards', [ReportCardController::class, 'index']);
Route::get('/report-cards/preview', [ReportCardController::class, 'preview']);

// Local check cases: see BillingController. All authenticated except /billing/register.
Route::middleware('auth:sanctum')->prefix('billing')->controller(BillingController::class)->group(function () {
    Route::post('/invoices', 'store');
    Route::post('/users/{user}/restore', 'restore');
    Route::post('/register', 'register')->withoutMiddleware('auth:sanctum');
    Route::put('/invoices/{invoice}', 'update');
    Route::get('/search', 'search');
    Route::get('/sorted', 'sorted');
    Route::get('/between', 'between');
});
