// authenticated (shared secret): the check is written as the allowed branch, then a 403
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('hub.verify_token');
  const expected = process.env.WEBHOOK_VERIFY_TOKEN?.trim();
  if (expected && token === expected) {
    return new Response(url.searchParams.get('hub.challenge'));
  }
  console.warn('verify token mismatch');
  return new Response('Forbidden', { status: 403 });
}
