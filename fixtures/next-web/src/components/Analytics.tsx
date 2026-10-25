'use client';

export function Analytics() {
  const track = () =>
    // No Laravel route exists for this: an unmatched HTTP call.
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/analytics`, { method: 'POST' });
  return <button onClick={track}>Track</button>;
}
