import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// authenticated (signature, low confidence): constructEvent throws on a bad signature and the catch returns 400
export async function POST(req: Request) {
  const body = await req.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, req.headers.get('stripe-signature') ?? '', process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return new Response('Bad signature', { status: 400 });
  }
  return Response.json({ received: event.type });
}
