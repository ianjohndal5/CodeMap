<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreUserRequest;
use App\Models\User;
use App\Services\UserService;

class UserController extends Controller
{
    public function __construct(private UserService $users)
    {
    }

    public function index()
    {
        return $this->ok($this->users->list());
    }

    public function show(User $user)
    {
        return $this->users->find($user->id);
    }

    public function store(StoreUserRequest $request)
    {
        $this->authorizeCreate();

        return $this->users->create($request->validated());
    }

    private function authorizeCreate(): void
    {
        // Not defined anywhere in this class: an uncertain edge to the class.
        $this->authorize('create', User::class);
    }
}
