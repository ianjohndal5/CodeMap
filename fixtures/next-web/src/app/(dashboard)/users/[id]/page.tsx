import { UserCard } from '@/components';

async function getUser(id: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/users/${id}`, { cache: 'no-store' });
  return res.json();
}

export default async function UserPage({ params }: { params: { id: string } }) {
  const user = await getUser(params.id);
  return <UserCard user={user} />;
}
