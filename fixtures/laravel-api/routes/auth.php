<?php

use App\Http\Controllers\AuthController;
use Illuminate\Support\Facades\Route;

Route::post('/logout', [AuthController::class, 'logout'])->middleware('auth');
