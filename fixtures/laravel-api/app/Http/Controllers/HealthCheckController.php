<?php

namespace App\Http\Controllers;

class HealthCheckController extends Controller
{
    public function __invoke()
    {
        return ['status' => 'ok', 'time' => now_iso()];
    }
}
