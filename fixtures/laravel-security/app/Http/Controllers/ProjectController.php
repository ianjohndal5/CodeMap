<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreProjectRequest;
use Illuminate\Foundation\Auth\Access\AuthorizesRequests;
use Illuminate\Routing\Attributes\Controllers\Middleware;
use Illuminate\Routing\Controller as BaseController;

class ProjectController extends BaseController
{
    use AuthorizesRequests;

    public function __construct()
    {
        $this->middleware('auth:sanctum')->except(['index', 'exports']);
        $this->middleware('throttle:api', ['only' => ['store']]);
    }

    public function index()
    {
        return [];
    }

    public function store(StoreProjectRequest $request)
    {
        return $request->validated();
    }

    #[Middleware('auth:sanctum')]
    public function exports()
    {
        return [];
    }

    public function destroy(int $project)
    {
        $this->authorize('delete-project', $project);

        return response()->noContent();
    }
}
