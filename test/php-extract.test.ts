import { describe, expect, it } from 'vitest';
import { extractPhp, type PhpFileInfo, type PhpRef } from '../src/lang/php/extract.js';
import { PhpScope } from '../src/lang/php/names.js';
import { parseSource } from '../src/parse.js';

const php = (src: string, rel = 'app/X.php'): PhpFileInfo => extractPhp(rel, parseSource('php', src).rootNode);

/** "owner -> kind target" strings for compact assertions. */
function refs(info: PhpFileInfo): string[] {
  const owner = (r: PhpRef) => {
    const o = r.owner;
    return o.type === 'method' ? `${o.cls.name}::${o.method}` : o.type === 'function' ? `${o.fn.name}()` : o.type === 'closure' ? 'closure' : 'file';
  };
  return info.refs.map((r) => {
    switch (r.kind) {
      case 'function':
        return `${owner(r)} -> function ${r.candidates.join('|')}`;
      case 'new':
        return `${owner(r)} -> new ${r.cls}`;
      case 'extends':
      case 'implements':
      case 'trait':
        return `${r.from.name} ${r.kind} ${r.cls}`;
      default:
        return `${owner(r)} -> ${r.kind} ${r.cls}::${r.method}`;
    }
  });
}

describe('PHP name resolution', () => {
  it('resolves names through namespace, use, aliases and group use', () => {
    const s = new PhpScope();
    s.enterNamespace('App\\Http\\Controllers');
    s.addUse('App\\Models\\User', null, 'class', 1);
    s.addUse('App\\Services\\Billing', 'Pay', 'class', 2);
    expect(s.resolveClass('User')).toBe('App\\Models\\User');
    expect(s.resolveClass('user')).toBe('App\\Models\\User'); // case-insensitive
    expect(s.resolveClass('Pay')).toBe('App\\Services\\Billing');
    expect(s.resolveClass('Pay\\Invoice')).toBe('App\\Services\\Billing\\Invoice');
    expect(s.resolveClass('Controller')).toBe('App\\Http\\Controllers\\Controller');
    expect(s.resolveClass('\\Illuminate\\Support\\Str')).toBe('Illuminate\\Support\\Str');
    expect(s.resolveClass('Admin\\Report')).toBe('App\\Http\\Controllers\\Admin\\Report');
    expect(s.resolveFunction('helper')).toEqual(['App\\Http\\Controllers\\helper', 'helper']);
  });

  it('reads use statements including group use and aliases', () => {
    const info = php(`<?php
namespace App\\Http;
use App\\Models\\{User, Post as P};
use Illuminate\\Support\\Facades\\Route as R;
use function App\\Support\\helper;
class K {}`);
    expect(info.useStatements.map((u) => u.fqn)).toEqual(['App\\Models\\User', 'App\\Models\\Post', 'Illuminate\\Support\\Facades\\Route']);
  });
});

describe('PHP definitions', () => {
  it('extracts namespaces, classes, interfaces, traits, enums, methods and functions', () => {
    const info = php(`<?php
namespace App\\Domain;

interface Repo { public function find(int $id); }
trait Loggable { protected function log() {} }
enum Status: string { case Active = 'a'; public function label(): string { return 'x'; } }
abstract class Base {
    public function run() {}
    private static function make() {}
    protected function guard() {}
}
if (! function_exists('helper')) {
    function helper() {}
}
function other() {}`);
    expect(info.namespaces).toEqual(['App\\Domain']);
    expect(info.classes.map((c) => `${c.kind} ${c.fqn}:${c.line}`)).toEqual([
      'interface App\\Domain\\Repo:4',
      'trait App\\Domain\\Loggable:5',
      'enum App\\Domain\\Status:6',
      'class App\\Domain\\Base:7',
    ]);
    const base = info.classes[3];
    expect(base.methods).toEqual([
      { name: 'run', line: 8, visibility: 'public', static: false },
      { name: 'make', line: 9, visibility: 'private', static: true },
      { name: 'guard', line: 10, visibility: 'protected', static: false },
    ]);
    expect(info.functions.map((f) => `${f.fqn}:${f.line}`)).toEqual(['App\\Domain\\helper:13', 'App\\Domain\\other:15']);
  });

  it('handles braced and multiple namespaces in one file', () => {
    const info = php(`<?php
namespace A { class One {} }
namespace B { use A\\One; class Two extends One {} }`);
    expect(info.classes.map((c) => c.fqn)).toEqual(['A\\One', 'B\\Two']);
    expect(info.classes[1].extends).toEqual(['A\\One']);
  });
});

describe('PHP calls and references', () => {
  const src = `<?php
namespace App\\Http\\Controllers;

use App\\Models\\User;
use App\\Services\\UserService;
use App\\Services\\Mailer as Mail;
use Illuminate\\Http\\Request;

class UserController extends Controller implements HasThing
{
    use Traits\\Audits;

    private ?Mail $mailer;
    protected $untyped;

    public function __construct(private UserService $users, int $n = 0) {}

    public function show(User $user, $raw, Request $request)
    {
        $this->users->find($user->id);   // promoted ctor property -> typed
        $this->mailer->send();            // typed property -> typed
        $this->untyped->go();             // untyped property -> unresolved
        $this->helper();                  // same class
        $this->authorize('x');            // not in class -> 'this' (uncertain later)
        self::make();
        static::make();
        parent::boot();                   // unresolved (inheritance not followed)
        User::find(1);                    // static on resolved class
        \\App\\Models\\Post::query();
        new UserService();
        $user->posts();                   // typed parameter
        $raw->thing();                    // untyped variable
        User::query()->latest()->get();   // fluent chain
        format_money(1);
        $fn = function () { $this->helper(); };
        return response()->json([]);
    }

    private function helper() {}
    private static function make() {}
}`;

  it('applies the certain-only resolution rules', () => {
    const info = php(src, 'app/Http/Controllers/UserController.php');
    expect(refs(info)).toEqual([
      'UserController extends App\\Http\\Controllers\\Controller',
      'UserController implements App\\Http\\Controllers\\HasThing',
      'UserController trait App\\Http\\Controllers\\Traits\\Audits',
      'UserController::show -> typed App\\Services\\UserService::find',
      'UserController::show -> typed App\\Services\\Mailer::send',
      'UserController::show -> this App\\Http\\Controllers\\UserController::helper',
      'UserController::show -> this App\\Http\\Controllers\\UserController::authorize',
      'UserController::show -> self App\\Http\\Controllers\\UserController::make',
      'UserController::show -> self App\\Http\\Controllers\\UserController::make',
      'UserController::show -> static App\\Models\\User::find',
      'UserController::show -> static App\\Models\\Post::query',
      'UserController::show -> new App\\Services\\UserService',
      'UserController::show -> typed App\\Models\\User::posts',
      'UserController::show -> static App\\Models\\User::query',
      'UserController::show -> function App\\Http\\Controllers\\format_money|format_money',
      'UserController::show -> this App\\Http\\Controllers\\UserController::helper',
      'UserController::show -> function App\\Http\\Controllers\\response|response',
    ]);
    expect(info.unresolved.map((u) => u.reason)).toEqual([
      'untyped-property',
      'parent-call',
      'untyped-variable',
      'chained-call',
      'chained-call',
      'chained-call',
    ]);
    expect(info.classes[0].propTypes).toEqual(
      new Map([
        ['mailer', 'App\\Services\\Mailer'],
        ['users', 'App\\Services\\UserService'],
      ]),
    );
  });

  it('does not trust a typed parameter that is reassigned', () => {
    const info = php(`<?php
use App\\Models\\User;
class A { public function f(User $u) { $u = other(); $u->save(); } }`);
    expect(info.refs.filter((r) => r.kind === 'typed')).toEqual([]);
    expect(info.unresolved.map((u) => u.reason)).toEqual(['untyped-variable']);
  });

  it('attributes calls inside route closures to the closure', () => {
    const source = `<?php
use App\\Services\\Health;
Route::get('/ping', function () { return Health::check(); });`;
    const root = parseSource('php', source).rootNode;
    const start = source.indexOf('function ()');
    const end = source.indexOf('});') + 1;
    const info = extractPhp('routes/api.php', root, new Map([[start, end]]));
    expect(info.closures).toHaveLength(1);
    expect(refs(info)).toContain('closure -> static App\\Services\\Health::check');
  });
});
