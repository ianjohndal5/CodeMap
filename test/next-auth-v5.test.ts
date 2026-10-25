import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { defaultConfig } from '../src/config.js';

// A src/ layout app with NextAuth v5 (Auth.js), the patterns found on a real project (rentalsph):
// `auth` re-exported from @/lib/auth, wrapped calls, IIFEs, `{ error }` guard results, and two
// proxy files, of which Next.js reads only src/proxy.ts.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seammap-authjs-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const files: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  'src/lib/auth.ts': `import NextAuth from 'next-auth'
export const { handlers, auth, signIn, signOut } = NextAuth({ providers: [] })`,
  'src/app/api/auth/[...nextauth]/route.ts': `import { handlers } from '@/lib/auth'
export const { GET, POST } = handlers`,
  'src/app/api/me/route.ts': `import { auth } from '@/lib/auth'
export async function GET() {
  const session = await auth()
  if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  return Response.json(session.user)
}`,
  'src/app/api/slow/route.ts': `import { auth } from '@/lib/auth'
function withTimeout<T>(p: Promise<T>): Promise<T> { return p }
export async function GET() {
  const session = await withTimeout(auth())
  if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  return Response.json({ ok: true })
}`,
  'src/app/api/search/route.ts': `import { auth } from '@/lib/auth'
export async function POST() {
  const owner = (async () => {
    const session = await auth()
    return session?.user?.id || null
  })()
  return Response.json({ owner: await owner })
}`,
  'src/app/api/admin/users/route.ts': `import { auth } from '@/lib/auth'
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  return Response.json([])
}`,
  'src/app/api/admin/stats/route.ts': `import { auth } from '@/lib/auth'
async function requireAdmin() {
  const session = await auth()
  if (!session?.user?.id) return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!['admin', 'super_admin'].includes(session.user.role)) return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) }
  return { userId: session.user.id }
}
export async function GET() {
  const guard = await requireAdmin()
  if (guard.error) return guard.error
  return Response.json({ users: 1 })
}`,
  'src/app/admin/export/route.ts': `export async function GET() {
  return new Response('id\\n1\\n')
}`,
  // Not read by Next.js (the app lives in src/): if SeamMap used it, /admin/export would look gated.
  'proxy.ts': `import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
export async function proxy(request: NextRequest) {
  const supabase = createServerClient('u', 'k', { cookies: { getAll: () => [] } })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user && request.nextUrl.pathname.startsWith('/admin')) return NextResponse.redirect(new URL('/login', request.url))
  return NextResponse.next()
}
export const config = { matcher: ['/admin/:path*'] }`,
  'src/proxy.ts': `import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
export async function proxy(request: NextRequest) {
  const supabase = createServerClient('u', 'k', { cookies: { getAll: () => [] } })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user && request.nextUrl.pathname.startsWith('/admin')) return NextResponse.redirect(new URL('/login', request.url))
  return NextResponse.next()
}
export const config = {
  matcher: [{ source: '/admin/:path*', missing: [{ type: 'header', key: 'next-router-prefetch' }] }],
}`,
};
for (const [rel, content] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
const report = analyze({ backend: null, frontend: root, config: defaultConfig(), security: true }).graph.security!;
const ep = (id: string) => report.endpoints.find((e) => e.id === `endpoint:next:${id}`)!;

describe('NextAuth v5 and src/ layout apps', () => {
  it('reads auth() from NextAuth({...}) wherever it is re-exported, also wrapped in another call', () => {
    expect(ep('GET /api/me')).toMatchObject({ state: 'authenticated', signals: [{ text: 'if (!session?.user)' }] });
    expect(ep('GET /api/slow').state).toBe('authenticated');
  });

  it("marks NextAuth's own handlers route, and an IIFE that reads the session without a guard, as unknown", () => {
    expect(ep('GET /api/auth/**').unknown).toEqual(['auth-library-route']);
    expect(ep('POST /api/auth/**').unknown).toEqual(['auth-library-route']);
    expect(ep('POST /api/search')).toMatchObject({ state: 'unknown', unknown: ['check-in-code'] });
  });

  it("counts a helper's { error } result passed on as the check, with its role test", () => {
    expect(ep('GET /api/admin/stats')).toMatchObject({ state: 'authorization', signals: [{ text: 'if (guard.error)' }] });
  });

  it('flags an admin path that only checks for a signed-in user', () => {
    expect(ep('GET /api/admin/users').review).toContain('admin path, but no role or permission check was found');
    expect(ep('GET /api/admin/stats').review).not.toContain('admin path, but no role or permission check was found');
  });

  it('reads src/proxy.ts (next to src/app), and does not count gates a request can skip with a header', () => {
    expect(report.nextMiddleware).toMatchObject({
      file: 'src/proxy.ts',
      ignored: ['proxy.ts'],
      matcher: ['/admin/:path*'],
      conditional: ['/admin/:path* (skipped when the request has header next-router-prefetch)'],
    });
    const exp = ep('GET /admin/export');
    expect(exp.state).toBe('none');
    expect(exp.notes.join('\n')).toMatch(/has\/missing conditions a request can avoid; not counted/);
    expect(report.caveats.join('\n')).toMatch(/proxy\.ts is not read by Next\.js/);
  });
});
