<?php

namespace App\Http\Controllers;

use App\Http\Resources\PostResource;
use App\Models\Post;

class PostController extends Controller
{
    public function index()
    {
        return PostResource::collection(Post::query()->latest()->paginate());
    }

    public function show(Post $post)
    {
        return new PostResource($post);
    }

    public function update(Post $post)
    {
        $post->update(request()->only('title', 'body'));

        return new PostResource($post);
    }

    public function destroy(Post $post)
    {
        $post->delete();

        return response()->noContent();
    }
}
