import { handleReport } from '../../../lib/reports';

// authenticated: the response is handleReport()'s, and it calls requireUser()
export async function GET(req: Request) {
  return handleReport(req);
}
