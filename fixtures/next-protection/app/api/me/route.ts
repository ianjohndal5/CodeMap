import { getCurrentUser } from '../../../lib/auth';

// authenticated: 401 when getCurrentUser() finds no user
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return Response.json(user);
}
