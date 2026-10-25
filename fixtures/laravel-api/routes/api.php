<?php

use App\Http\Controllers\Admin\ReportController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\HealthCheckController;
use App\Http\Controllers\PostController;
use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

// Closure route.
Route::get('/ping', function () {
    return response()->json(['pong' => true]);
});

// Invokable controller.
Route::get('/health', HealthCheckController::class);

// Array-syntax action.
Route::post('/login', [AuthController::class, 'login'])->name('login');

// Legacy string action, resolved relative to App\Http\Controllers.
Route::get('/me', 'AuthController@me');

Route::prefix('v1')->middleware('auth:sanctum')->group(function () {
    Route::apiResource('users', UserController::class)->only(['index', 'show', 'store']);

    Route::controller(PostController::class)->group(function () {
        Route::get('/posts', 'index');
        Route::get('/posts/{post}', 'show');
        Route::match(['put', 'patch'], '/posts/{post}', 'update');
        // No frontend code calls this endpoint.
        Route::delete('/posts/{post}', 'destroy');
    });

    Route::group(['prefix' => 'admin'], function () {
        Route::get('/reports/{year?}', [ReportController::class, 'index'])->where('year', '[0-9]+');
        // Included file inherits the /api/v1/admin prefix.
        require __DIR__.'/admin.php';
    });
});

Route::fallback(fn () => response()->json(['message' => 'Not Found'], 404));
