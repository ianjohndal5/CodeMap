<?php

namespace App\Http\Controllers;

use Illuminate\Routing\Attributes\Controllers\Authorize;
use Illuminate\Routing\Attributes\Controllers\Middleware;
use Illuminate\Routing\Attributes\Controllers\WithoutMiddleware;

#[Middleware('auth:sanctum')]
class ReportCardController extends Controller
{
    #[Authorize('view-report-cards')]
    public function index()
    {
        return [];
    }

    #[WithoutMiddleware('auth:sanctum')]
    public function preview()
    {
        return [];
    }
}
