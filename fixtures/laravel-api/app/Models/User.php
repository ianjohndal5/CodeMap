<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class User extends Model
{
    protected $fillable = ['name', 'email'];

    public function posts()
    {
        return $this->hasMany(Post::class);
    }

    public static function findByEmail(string $email): ?self
    {
        return static::where('email', $email)->first();
    }
}
