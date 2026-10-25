// authenticated (shared secret): 401 unless the Authorization header carries CRON_SECRET
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  return Response.json({ cleaned: true });
}
