import type { NextApiRequest, NextApiResponse } from 'next';
import { AuthService } from '../../../lib/auth-service';
import { withMethods } from '../../../lib/pages-api';

// none, decided per method: GET is public; DELETE checks an API key through AuthService (pages-router style)
export default withMethods({
  GET: async (_req: NextApiRequest, res: NextApiResponse) => res.json([{ id: 1 }]),
  DELETE: async (req: NextApiRequest, res: NextApiResponse) => {
    if (!AuthService.handleApiKey(req, res)) return;
    res.json({ deleted: req.query.id });
  },
});
