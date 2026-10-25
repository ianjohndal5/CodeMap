<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreProjectRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('create-project');
    }

    public function rules(): array
    {
        return ['name' => 'required|string'];
    }
}
