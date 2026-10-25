<?php

namespace App\Http\Controllers;

use App\Models\Invoice;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

// Local check cases (codemap --security). Each comment says whether CodeMap should flag the method.
class BillingController extends Controller
{
    // flagged: all input into a model with $guarded = [].
    public function store(Request $request)
    {
        return Invoice::create($request->all());
    }

    // flagged: forceFill() ignores $fillable and $guarded.
    public function restore(Request $request, User $user)
    {
        $user->forceFill($request->except(['id']))->save();

        return $user;
    }

    // not flagged: User declares $fillable.
    public function register(Request $request)
    {
        return User::create($request->all());
    }

    // not flagged: validated input.
    public function update(Request $request, Invoice $invoice)
    {
        $invoice->update($request->validate(['total' => 'numeric']));

        return $invoice;
    }

    // flagged: request input interpolated into raw SQL.
    public function search(Request $request)
    {
        return DB::select("select * from invoices where number = '{$request->input('number')}'");
    }

    // flagged (medium): the same through a local variable.
    public function sorted(Request $request)
    {
        $column = $request->query('sort', 'created_at');

        return Invoice::query()->orderByRaw("$column desc")->get();
    }

    // not flagged: bound parameters and an int cast.
    public function between(Request $request)
    {
        return Invoice::query()
            ->whereRaw('total between ? and ?', [$request->min, $request->max])
            ->havingRaw('count(*) > '.(int) $request->input('count'))
            ->get();
    }
}
