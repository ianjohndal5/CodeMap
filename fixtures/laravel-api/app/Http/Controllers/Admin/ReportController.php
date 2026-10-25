<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Services\ReportService;

class ReportController extends Controller
{
    public function index(?int $year = null)
    {
        return ReportService::summary($year ?? (int) date('Y'));
    }

    public function export()
    {
        $service = new ReportService();

        return $service->toCsv();
    }
}
