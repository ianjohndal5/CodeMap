import { withUser } from '../../../lib/auth';

// authenticated: the withUser() wrapper returns 401 without a user
export const POST = withUser(async (req, user) => {
  const body = await req.json();
  return Response.json({ ...body, owner: user.id });
});
