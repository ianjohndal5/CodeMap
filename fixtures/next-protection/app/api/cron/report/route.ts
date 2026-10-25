// authenticated (shared secret): the flag is set from comparing the bearer token with CRON_SECRET
export async function GET(request: Request) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '');
  const authorized = Boolean(process.env.CRON_SECRET && token === process.env.CRON_SECRET);
  if (!authorized) return new Response('Unauthorized', { status: 401 });
  return Response.json({ sent: true });
}
