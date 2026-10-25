/** Checks a gateway token when there is one; without a token it returns null and decides nothing. */
export async function verifyGatewayToken(token: string | null) {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (signature !== process.env.GATEWAY_SECRET) throw new Error('Invalid gateway token');
  return { project: payload };
}
