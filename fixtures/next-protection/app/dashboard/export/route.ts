// authenticated (middleware.ts): no check here, but middleware redirects signed-out users on /dashboard
export async function GET() {
  return new Response('id,total\n1,10\n', { headers: { 'Content-Type': 'text/csv' } });
}
