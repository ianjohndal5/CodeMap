import { getCurrentUser } from '../../../lib/auth';

// unknown: reads the user to personalize, but no branch denies the request without one
export async function GET() {
  const user = await getCurrentUser();
  const items = user ? [{ id: 1, for: user.id }] : [{ id: 2, popular: true }];
  return Response.json(items);
}
