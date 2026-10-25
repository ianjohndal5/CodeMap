const API_URL = process.env.NEXT_PUBLIC_API_URL;

export async function StatusBadge() {
  const res = await fetch(`${API_URL}/api/ping`);
  const body = await res.json();
  return <span>{body.pong ? 'up' : 'down'}</span>;
}
