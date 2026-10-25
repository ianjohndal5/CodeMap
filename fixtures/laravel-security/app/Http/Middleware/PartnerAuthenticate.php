<?php

namespace App\Http\Middleware;

use Illuminate\Auth\Middleware\Authenticate;

class PartnerAuthenticate extends Authenticate
{
    protected function redirectTo($request): ?string
    {
        return null;
    }
}
