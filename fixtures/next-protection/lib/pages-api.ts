import type { NextApiRequest, NextApiResponse } from 'next';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

/** Dispatches by method; checks nothing itself. */
export function withMethods(handlers: Partial<Record<string, Handler>>) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const handler = handlers[req.method ?? 'GET'];
    if (!handler) return res.status(405).end();
    return handler(req, res);
  };
}
