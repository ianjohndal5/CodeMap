// Next.js file conventions (App Router and Pages Router), derived from paths only.

export interface NextFileInfo {
  /** page, layout, loading, error, not-found, template, default, route, global-error, middleware, api, app, document */
  nextKind?: string;
  /** URL path for pages and route handlers, e.g. /users/[id]. */
  route?: string;
  router?: 'app' | 'pages';
}

const APP_SPECIAL = new Set(['page', 'layout', 'loading', 'error', 'not-found', 'template', 'default', 'route', 'global-error', 'forbidden', 'unauthorized']);
const PAGE_EXT = /\.(tsx|ts|jsx|js|mjs)$/;

/** Turn route directory segments into a URL path: drop (groups), @slots and interception markers. */
export function routeFromSegments(segs: string[]): string {
  const kept = segs
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@'))
    // Intercepting routes: (.)photo, (..)photo, (...)photo, (..)(..)photo
    .map((s) => s.replace(/^(\(\.{1,3}\))+/, ''))
    .filter((s) => s !== '');
  return '/' + kept.join('/');
}

export function nextFileInfo(rel: string): NextFileInfo {
  if (!PAGE_EXT.test(rel)) return {};
  const stripped = rel.replace(/^src\//, '');
  const base = stripped.replace(PAGE_EXT, '');

  if (base === 'middleware' || base === 'instrumentation') return { nextKind: base };

  if (stripped.startsWith('app/')) {
    const parts = base.split('/').slice(1);
    const name = parts.pop() as string;
    if (!APP_SPECIAL.has(name)) return { router: 'app' };
    return { nextKind: name, route: routeFromSegments(parts), router: 'app' };
  }
  if (stripped.startsWith('pages/')) {
    const parts = base.split('/').slice(1);
    const name = parts[parts.length - 1];
    if (parts.length === 1 && name === '_app') return { nextKind: 'app', router: 'pages' };
    if (parts.length === 1 && name === '_document') return { nextKind: 'document', router: 'pages' };
    if (parts.length === 1 && (name === '_error' || name === '404' || name === '500')) return { nextKind: 'error', router: 'pages' };
    if (name === 'index') parts.pop();
    const route = '/' + parts.join('/');
    return { nextKind: parts[0] === 'api' ? 'api' : 'page', route, router: 'pages' };
  }
  return {};
}

export const ROUTE_HANDLER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
