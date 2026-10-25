<?php

namespace App\Http\Controllers;

use App\Models\Team;
use Illuminate\Foundation\Auth\Access\AuthorizesRequests;
use Illuminate\Routing\Controller as BaseController;

class TeamController extends BaseController
{
    use AuthorizesRequests;

    public function __construct()
    {
        $this->authorizeResource(Team::class);
    }

    public function index()
    {
        return [];
    }

    public function export()
    {
        return ['csv' => ''];
    }
}
