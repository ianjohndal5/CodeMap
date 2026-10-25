import { redirect } from 'next/navigation';
import { createClient } from './supabase/server';

export type User = { id: string; role: string };

/** The signed-in user with their role, or null. Does not deny anything itself. */
export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from('profiles').select('id, role').eq('id', user.id).single();
  return profile ? { id: user.id, role: profile.role } : null;
}

/** Redirects to /login without a user: callers need no check of their own. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

/** Throws unless the user is an admin. */
export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (!ADMIN_ROLES.has(user.role)) throw new Error('Forbidden');
  return user;
}

/** Throws unless the user it is given is an admin. */
export function assertAdmin(user: User | null): asserts user is User {
  if (!user || !ADMIN_ROLES.has(user.role)) throw new Error('Forbidden');
}

export function isAdmin(user: User): boolean {
  return ADMIN_ROLES.has(user.role);
}

/** Route handler wrapper: 401 without a user, otherwise calls the handler with the user. */
export function withUser(handler: (req: Request, user: User) => Promise<Response>) {
  return async (req: Request) => {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    return handler(req, user);
  };
}
