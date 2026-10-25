import { SessionInfo } from '@/components';
import { StatusBadge } from '@/components/StatusBadge';
import { Analytics } from '@/components/Analytics';

async function getHealth() {
  // String concatenation with an env base URL.
  const res = await fetch(process.env.NEXT_PUBLIC_API_URL + '/api/health', { cache: 'no-store' });
  return res.json();
}

async function getGreeting() {
  // Pages Router API route in src/pages/api/hello.ts.
  const res = await fetch('/api/hello');
  return res.json();
}

export default async function HomePage() {
  const health = await getHealth();
  const greeting = await getGreeting();
  return (
    <main>
      <h1>{greeting.text}</h1>
      <p>Backend: {health.status}</p>
      <StatusBadge />
      <SessionInfo />
      <Analytics />
    </main>
  );
}
