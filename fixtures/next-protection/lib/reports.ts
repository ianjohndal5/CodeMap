import { requireUser } from './auth';

export async function handleReport(req: Request) {
  const user = await requireUser();
  const url = new URL(req.url);
  return Response.json({ owner: user.id, range: url.searchParams.get('range') });
}
