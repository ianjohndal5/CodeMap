'use client';

import { useEffect, useState } from 'react';
import { useMe } from '@/hooks/useMe';

export function SessionInfo() {
  const me = useMe();
  const [session, setSession] = useState<unknown>(null);
  useEffect(() => {
    // Relative URL handled by the Next.js route handler in app/api/session/route.ts.
    fetch('/api/session').then((r) => r.json()).then(setSession);
  }, []);
  return <pre>{JSON.stringify({ me, session })}</pre>;
}
