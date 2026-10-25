/** Only says whether a server-side key is configured. */
function hasUpstreamAuth(): boolean {
  return Boolean(process.env.UPSTREAM_API_KEY);
}

// none: hasUpstreamAuth() checks configuration, never the caller
export async function GET() {
  if (!hasUpstreamAuth()) return Response.json({ error: 'not configured' }, { status: 500 });
  return fetch('https://upstream.example.com/items', { headers: { 'X-Api-Key': process.env.UPSTREAM_API_KEY! } });
}
