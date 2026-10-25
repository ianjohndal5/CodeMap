<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        health: '/up',
        then: function () {
            // A route file loaded by code: it gets exactly the middleware written here.
            Route::middleware('api')->prefix('partner-api')->group(base_path('routes/partner.php'));
        },
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->alias([
            'admin.only' => \App\Http\Middleware\EnsureAdmin::class,
            'auth.partner' => \App\Http\Middleware\PartnerAuthenticate::class,
        ]);

        $middleware->appendToGroup('partner', [
            'auth:sanctum',
            \App\Http\Middleware\EnsureJsonResponse::class,
        ]);
    })
    ->create();
