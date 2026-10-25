import { NextResponse } from 'next/server';

// Backend-for-frontend proxy: the browser calls /api/session, this handler calls Laravel.
export async function GET(request: Request) {
  const res = await fetch(`${process.env.API_URL}/api/me`, {
    headers: { cookie: request.headers.get('cookie') ?? '' },
  });
  return NextResponse.json(await res.json(), { status: res.status });
}
