<?php

namespace App\Services;

use App\Models\Post;

class ReportService
{
    public static function summary(int $year): array
    {
        return [
            'year' => $year,
            'posts' => Post::whereYear('created_at', $year)->count(),
            'generated' => format_report_date(),
        ];
    }

    public function toCsv(): string
    {
        $rows = self::summary((int) date('Y'));

        return implode(',', $rows);
    }
}
