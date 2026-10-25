// none: a public listing, nothing checks the session
export async function GET() {
  return Response.json([{ id: 1, title: 'House' }]);
}
