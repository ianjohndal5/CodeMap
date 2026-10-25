'use client';

import { useState } from 'react';
import api from '@/lib/axios';
import * as users from '@/lib/users';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = async () => {
    await api.post('/api/login', { email, password });
  };

  return (
    <form onSubmit={submit}>
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Log in</button>
      <button type="button" onClick={() => users.logout()}>
        Log out
      </button>
    </form>
  );
}
