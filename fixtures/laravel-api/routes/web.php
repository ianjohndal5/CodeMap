<?php

use Illuminate\Support\Facades\Route;

// Unprefixed closure route (web routes get no /api prefix).
Route::get('/', function () {
    return ['app' => 'laravel-api'];
});

Route::view('/welcome', 'welcome');
Route::redirect('/home', '/');

require __DIR__.'/auth.php';
