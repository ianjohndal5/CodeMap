import { getCurrentUser } from '../../../lib/auth';

// authenticated, not authorization: admins get more, but nobody signed in is refused for their role
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role === 'admin' || user.role === 'super_admin') {
    return Response.json({ all: true });
  }
  return Response.json({ published: true });
}
