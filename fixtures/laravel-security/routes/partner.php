<?php

use App\Http\Controllers\AccountController;
use Illuminate\Support\Facades\Route;

// Loaded from bootstrap/app.php `then:` with the api group and the /partner-api prefix.

// authenticated: auth.partner aliases a class that extends Laravel's Authenticate.
Route::group(['middleware' => ['auth.partner']], function () {
    Route::get('/orders', [AccountController::class, 'partnerOrders']);
});

// authenticated: the 'partner' group (bootstrap/app.php appendToGroup) contains auth:sanctum.
Route::middleware('partner')->get('/feed', [AccountController::class, 'partnerFeed']);
