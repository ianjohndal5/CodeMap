import { assertAdmin, getCurrentUser } from '../../../../lib/auth';

// authorization: assertAdmin(user) throws unless the user it is given is an admin
export async function GET() {
  const user = await getCurrentUser();
  assertAdmin(user);
  return Response.json({ users: 10, by: user.id });
}
