import { withRateLimit } from 'next-rate-limit-kit';

// unknown: the package wrapper cannot be read, so whatever it checks is not known
export const GET = withRateLimit(async () => Response.json({ ok: true }));
