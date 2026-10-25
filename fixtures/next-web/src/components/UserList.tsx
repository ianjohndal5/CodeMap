'use client';

import { useEffect, useState } from 'react';
import { listUsers, type User } from '@/lib/users';
import { UserCard } from './UserCard';

export default function UserList() {
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => {
    listUsers().then(setUsers);
  }, []);
  return (
    <ul>
      {users.map((u) => (
        <UserCard key={u.id} user={u} />
      ))}
    </ul>
  );
}
