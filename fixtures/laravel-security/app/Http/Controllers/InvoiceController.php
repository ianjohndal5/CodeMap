<?php

namespace App\Http\Controllers;

use Illuminate\Routing\Controllers\HasMiddleware;
use Illuminate\Routing\Controllers\Middleware;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Gate;

class InvoiceController extends Controller implements HasMiddleware
{
    public static function middleware(): array
    {
        return [
            'auth:sanctum',
            new Middleware('can:view-invoices', only: ['index']),
        ];
    }

    public function index()
    {
        return [];
    }

    public function show(int $invoice)
    {
        if (Gate::denies('view-invoice', $invoice)) {
            abort(403);
        }

        return ['id' => $invoice];
    }

    public function pdf(int $invoice)
    {
        $watermark = Auth::check() ? 'member' : 'guest';

        return ['id' => $invoice, 'watermark' => $watermark];
    }
}
