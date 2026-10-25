import crypto from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

export class AuthService {
  static verifyApiKey(header: string | undefined): boolean {
    const expected = process.env.ADMIN_API_KEY;
    if (!header || !expected) return false;
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  }

  /** Writes the 401 itself and returns false: callers only stop. */
  static handleApiKey(req: NextApiRequest, res: NextApiResponse): boolean {
    if (!AuthService.verifyApiKey(req.headers.authorization)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  }
}
