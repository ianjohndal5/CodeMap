<?php

use Illuminate\Support\Facades\Broadcast;

Broadcast::channel('users.{id}', fn ($user, $id) => (int) $user->id === (int) $id);
