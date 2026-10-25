<?php

use App\Http\Controllers\AccountController;
use Illuminate\Support\Facades\Route;

// none: the web group has no access middleware.
Route::get('/', function () {
    return view('welcome');
});

// authenticated: auth and verified on a group.
Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('/dashboard', [AccountController::class, 'show']);
});
