import { getCurrentUser, requireAdmin } from '../../../../lib/auth';

// authorization: 401 without a user, 403 unless the role is admin
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
  return Response.json([]);
}

// authorization: requireAdmin() throws for everyone else
export async function DELETE(req: Request) {
  await requireAdmin();
  const { id } = await req.json();
  return Response.json({ deleted: id });
}
