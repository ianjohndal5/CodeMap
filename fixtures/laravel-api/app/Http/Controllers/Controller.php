<?php

namespace App\Http\Controllers;

abstract class Controller
{
    protected function ok(mixed $data): array
    {
        return ['data' => $data];
    }
}
