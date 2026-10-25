<?php

use Illuminate\Support\Facades\Route;

// unknown: nothing CodeMap reads loads this file, so its middleware is unknown.
Route::get('/legacy/ping', fn () => 'pong');
