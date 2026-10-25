<?php

namespace App\Services;

use App\Models\User;

class UserService
{
    public function list()
    {
        return User::query()->latest()->get();
    }

    public function find(int $id): User
    {
        return User::findOrFail($id);
    }

    public function create(array $data): User
    {
        $existing = User::findByEmail($data['email']);

        return $existing ?? User::create($this->normalize($data));
    }

    private function normalize(array $data): array
    {
        return array_map('trim', $data);
    }
}
