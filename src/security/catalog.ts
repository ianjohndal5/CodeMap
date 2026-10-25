import type { Effect } from './types.js';

// Framework and well-known package middleware, by class. Anything not listed here (and
// not reaching one of these through `extends` in the project) is unknown, never neutral.

const known: [string, Effect, string][] = [
  // Laravel: access
  ['Illuminate\\Auth\\Middleware\\Authenticate', 'authentication', 'requires a signed-in user'],
  ['Illuminate\\Auth\\Middleware\\AuthenticateWithBasicAuth', 'authentication', 'requires HTTP basic auth'],
  ['Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified', 'authentication', 'requires a signed-in user with a verified email'],
  ['Illuminate\\Auth\\Middleware\\RequirePassword', 'authentication', 'requires a recent password confirmation'],
  ['Illuminate\\Auth\\Middleware\\Authorize', 'authorization', 'gate / policy check before the handler'],
  ['Illuminate\\Auth\\Middleware\\RedirectIfAuthenticated', 'public', 'guest only: signed-in users are redirected'],
  ['Illuminate\\Routing\\Middleware\\ValidateSignature', 'signed', 'requires a valid URL signature'],
  // Laravel: no effect on who may call
  ['Illuminate\\Session\\Middleware\\AuthenticateSession', 'neutral', 'invalidates other sessions; does not block guests'],
  ['Illuminate\\Routing\\Middleware\\ThrottleRequests', 'neutral', 'rate limit'],
  ['Illuminate\\Routing\\Middleware\\ThrottleRequestsWithRedis', 'neutral', 'rate limit'],
  ['Illuminate\\Routing\\Middleware\\SubstituteBindings', 'neutral', 'route model binding'],
  ['Illuminate\\Http\\Middleware\\SetCacheHeaders', 'neutral', 'cache headers'],
  ['Illuminate\\Foundation\\Http\\Middleware\\HandlePrecognitiveRequests', 'neutral', 'precognition'],
  ['Illuminate\\Cookie\\Middleware\\EncryptCookies', 'neutral', 'cookies'],
  ['Illuminate\\Cookie\\Middleware\\AddQueuedCookiesToResponse', 'neutral', 'cookies'],
  ['Illuminate\\Session\\Middleware\\StartSession', 'neutral', 'session'],
  ['Illuminate\\View\\Middleware\\ShareErrorsFromSession', 'neutral', 'session'],
  ['Illuminate\\Foundation\\Http\\Middleware\\ValidateCsrfToken', 'neutral', 'CSRF token (not access control)'],
  ['Illuminate\\Foundation\\Http\\Middleware\\VerifyCsrfToken', 'neutral', 'CSRF token (not access control)'],
  ['Illuminate\\Foundation\\Http\\Middleware\\PreventRequestForgery', 'neutral', 'CSRF / request origin check (not access control)'],
  ['Illuminate\\Foundation\\Http\\Middleware\\InvokeDeferredCallbacks', 'neutral', 'framework'],
  ['Illuminate\\Foundation\\Http\\Middleware\\PreventRequestsDuringMaintenance', 'neutral', 'maintenance mode'],
  ['Illuminate\\Foundation\\Http\\Middleware\\CheckForMaintenanceMode', 'neutral', 'maintenance mode'],
  ['Illuminate\\Foundation\\Http\\Middleware\\ValidatePostSize', 'neutral', 'request size'],
  ['Illuminate\\Http\\Middleware\\ValidatePostSize', 'neutral', 'request size'],
  ['Illuminate\\Foundation\\Http\\Middleware\\TrimStrings', 'neutral', 'input'],
  ['Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull', 'neutral', 'input'],
  ['Illuminate\\Http\\Middleware\\TrustProxies', 'neutral', 'proxies'],
  ['Illuminate\\Http\\Middleware\\TrustHosts', 'neutral', 'host header'],
  ['Illuminate\\Http\\Middleware\\HandleCors', 'neutral', 'CORS headers (configuration not analyzed)'],
  ['Illuminate\\Http\\Middleware\\ValidatePathEncoding', 'neutral', 'input'],
  ['Illuminate\\Http\\Middleware\\AddLinkHeadersForPreloadedAssets', 'neutral', 'headers'],
  ['Illuminate\\Http\\Middleware\\FrameGuard', 'neutral', 'headers'],
  ['Illuminate\\Http\\Middleware\\CheckResponseForModifications', 'neutral', 'headers'],
  ['Fruitcake\\Cors\\HandleCors', 'neutral', 'CORS headers (configuration not analyzed)'],
  // Sanctum
  ['Laravel\\Sanctum\\Http\\Middleware\\EnsureFrontendRequestsAreStateful', 'neutral', 'enables session auth for the SPA; does not block guests'],
  ['Laravel\\Sanctum\\Http\\Middleware\\AuthenticateSession', 'neutral', 'invalidates other sessions; does not block guests'],
  ['Laravel\\Sanctum\\Http\\Middleware\\CheckAbilities', 'authorization', 'token abilities'],
  ['Laravel\\Sanctum\\Http\\Middleware\\CheckForAnyAbility', 'authorization', 'token abilities'],
  // Passport
  ['Laravel\\Passport\\Http\\Middleware\\CheckScopes', 'authorization', 'token scopes'],
  ['Laravel\\Passport\\Http\\Middleware\\CheckForAnyScope', 'authorization', 'token scopes'],
  ['Laravel\\Passport\\Http\\Middleware\\CheckToken', 'authorization', 'token scopes'],
  ['Laravel\\Passport\\Http\\Middleware\\CheckTokenForAnyScope', 'authorization', 'token scopes'],
  ['Laravel\\Passport\\Http\\Middleware\\CheckClientCredentials', 'authentication', 'client credentials token'],
  ['Laravel\\Passport\\Http\\Middleware\\CheckClientCredentialsForAnyScope', 'authentication', 'client credentials token'],
  ['Laravel\\Passport\\Http\\Middleware\\CreateFreshApiToken', 'neutral', 'adds an API token cookie; does not block guests'],
  // Jetstream / Inertia
  ['Laravel\\Jetstream\\Http\\Middleware\\AuthenticateSession', 'neutral', 'invalidates other sessions; does not block guests'],
  ['Inertia\\Middleware', 'neutral', 'Inertia shared data'],
  // spatie/laravel-permission (v6 and the older Middlewares namespace)
  ['Spatie\\Permission\\Middleware\\RoleMiddleware', 'authorization', 'role check'],
  ['Spatie\\Permission\\Middleware\\PermissionMiddleware', 'authorization', 'permission check'],
  ['Spatie\\Permission\\Middleware\\RoleOrPermissionMiddleware', 'authorization', 'role or permission check'],
  ['Spatie\\Permission\\Middlewares\\RoleMiddleware', 'authorization', 'role check'],
  ['Spatie\\Permission\\Middlewares\\PermissionMiddleware', 'authorization', 'permission check'],
  ['Spatie\\Permission\\Middlewares\\RoleOrPermissionMiddleware', 'authorization', 'role or permission check'],
];

export const KNOWN_CLASSES = new Map(known.map(([fqn, effect, label]) => [fqn.toLowerCase(), { fqn, effect, label }]));

/** Laravel 11+ `Middleware::defaultAliases()`; also the aliases every Laravel <= 10 skeleton Kernel declares. */
export const DEFAULT_ALIASES: Record<string, string> = {
  auth: 'Illuminate\\Auth\\Middleware\\Authenticate',
  'auth.basic': 'Illuminate\\Auth\\Middleware\\AuthenticateWithBasicAuth',
  'auth.session': 'Illuminate\\Session\\Middleware\\AuthenticateSession',
  'cache.headers': 'Illuminate\\Http\\Middleware\\SetCacheHeaders',
  can: 'Illuminate\\Auth\\Middleware\\Authorize',
  guest: 'Illuminate\\Auth\\Middleware\\RedirectIfAuthenticated',
  'password.confirm': 'Illuminate\\Auth\\Middleware\\RequirePassword',
  precognitive: 'Illuminate\\Foundation\\Http\\Middleware\\HandlePrecognitiveRequests',
  signed: 'Illuminate\\Routing\\Middleware\\ValidateSignature',
  throttle: 'Illuminate\\Routing\\Middleware\\ThrottleRequests',
  verified: 'Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified',
};

/** Laravel 11+ default groups (`Middleware::getMiddlewareGroups()`); neither contains authentication. */
export const DEFAULT_GROUPS: Record<string, string[]> = {
  web: [
    'Illuminate\\Cookie\\Middleware\\EncryptCookies',
    'Illuminate\\Cookie\\Middleware\\AddQueuedCookiesToResponse',
    'Illuminate\\Session\\Middleware\\StartSession',
    'Illuminate\\View\\Middleware\\ShareErrorsFromSession',
    'Illuminate\\Foundation\\Http\\Middleware\\ValidateCsrfToken',
    'Illuminate\\Routing\\Middleware\\SubstituteBindings',
  ],
  api: ['Illuminate\\Routing\\Middleware\\SubstituteBindings'],
};

/** Laravel 11+ default global middleware. */
export const DEFAULT_GLOBAL: string[] = [
  'Illuminate\\Foundation\\Http\\Middleware\\InvokeDeferredCallbacks',
  'Illuminate\\Http\\Middleware\\TrustProxies',
  'Illuminate\\Http\\Middleware\\HandleCors',
  'Illuminate\\Foundation\\Http\\Middleware\\PreventRequestsDuringMaintenance',
  'Illuminate\\Http\\Middleware\\ValidatePostSize',
  'Illuminate\\Foundation\\Http\\Middleware\\TrimStrings',
  'Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull',
];

/** Base controllers without constructor middleware. */
export const FRAMEWORK_CONTROLLERS = new Set(['illuminate\\routing\\controller', 'laravel\\lumen\\routing\\controller']);

export const FORM_REQUEST = 'illuminate\\foundation\\http\\formrequest';
export const HAS_MIDDLEWARE = 'illuminate\\routing\\controllers\\hasmiddleware';
export const CONTROLLER_MIDDLEWARE = 'illuminate\\routing\\controllers\\middleware';
/** Laravel 13 controller attributes. */
export const ATTR_MIDDLEWARE = 'illuminate\\routing\\attributes\\controllers\\middleware';
export const ATTR_AUTHORIZE = 'illuminate\\routing\\attributes\\controllers\\authorize';
export const ATTR_WITHOUT = 'illuminate\\routing\\attributes\\controllers\\withoutmiddleware';

/** Package route registrations SeamMap cannot see, keyed by composer package. */
export const ROUTE_PACKAGES: Record<string, string> = {
  'laravel/sanctum': 'Sanctum registers /sanctum/csrf-cookie',
  'laravel/fortify': 'Fortify registers login, registration, password reset and 2FA routes',
  'laravel/passport': 'Passport registers /oauth/* routes',
  'laravel/jetstream': 'Jetstream registers profile, team and API token routes',
  'laravel/horizon': 'Horizon registers its dashboard routes',
  'laravel/telescope': 'Telescope registers its dashboard routes',
  'laravel/pulse': 'Pulse registers its dashboard route',
  'laravel/cashier': 'Cashier registers its webhook route',
  'livewire/livewire': 'Livewire registers its update and upload endpoints',
  'filament/filament': 'Filament registers its panel routes',
  'laravel/nova': 'Nova registers its routes',
};
