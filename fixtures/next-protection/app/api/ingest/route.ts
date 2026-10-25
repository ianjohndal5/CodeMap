import { verifyGatewayToken } from '../../../lib/gateway';

// unknown: verifyGatewayToken() returns null without a token, so it stops nobody, and nothing else checks
export async function POST(req: Request) {
  const gateway = await verifyGatewayToken(req.headers.get('x-gateway-token'));
  const body = await req.json();
  return Response.json({ via: gateway ? 'gateway' : 'direct', body });
}
