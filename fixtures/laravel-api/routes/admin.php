<?php

use App\Http\Controllers\Admin\ReportController;
use Illuminate\Support\Facades\Route;

Route::post('/reports/export', [ReportController::class, 'export']);
