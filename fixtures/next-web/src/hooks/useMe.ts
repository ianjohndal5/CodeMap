'use client';

import { useEffect, useState } from 'react';

export function useMe() {
  const [me, setMe] = useState<unknown>(null);
  useEffect(() => {
    // Relative URL with no matching Next.js route handler: may be proxied to Laravel.
    fetch('/api/me', { credentials: 'include' })
      .then((r) => r.json())
      .then(setMe);
  }, []);
  return me;
}
