// none: checking that an API key is configured is not a check on the caller
export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: 'AI is not configured' }, { status: 500 });
  }
  const { prompt } = await req.json();
  return Response.json({ echo: prompt });
}
