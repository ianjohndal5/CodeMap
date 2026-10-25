import { verifyRequest } from 'partner-auth-sdk';

// unknown: the request stops on verifyRequest(), which comes from a package CodeMap cannot read
export async function POST(req: Request) {
  const result = await verifyRequest(req);
  if (!result.ok) return new Response('Denied', { status: 401 });
  return Response.json({ ok: true });
}
