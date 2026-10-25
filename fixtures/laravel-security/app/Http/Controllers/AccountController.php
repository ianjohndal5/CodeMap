<?php

namespace App\Http\Controllers;

use App\Http\Requests\FeedbackRequest;
use App\Models\User;
use Illuminate\Http\Request;

class AccountController extends Controller
{
    public function signup(Request $request)
    {
        return User::create($request->only('name', 'email'));
    }

    public function status()
    {
        return ['ok' => true];
    }

    public function unsubscribe(User $user)
    {
        return $this->ok($user->id);
    }

    public function feedback(FeedbackRequest $request)
    {
        return $this->ok($request->validated());
    }

    public function settings()
    {
        return $this->ok([]);
    }

    public function publicReport(Request $request)
    {
        $drafts = [];
        if ($request->user()?->can('see-drafts')) {
            $drafts = ['draft'];
        }

        return $this->ok($drafts);
    }

    public function show(Request $request)
    {
        return $request->user();
    }

    public function update(Request $request)
    {
        $request->user()->update($request->only('name'));

        return $request->user();
    }

    public function ping()
    {
        return ['pong' => true];
    }

    public function avatar(User $user)
    {
        return $this->ok($user->id);
    }

    public function partnerOrders()
    {
        return $this->ok([]);
    }

    public function partnerFeed()
    {
        return $this->ok([]);
    }
}
