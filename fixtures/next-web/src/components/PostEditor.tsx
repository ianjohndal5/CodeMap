'use client';

import { useState } from 'react';
import api from '@/lib/axios';

export function PostEditor({ id }: { id: string }) {
  const [title, setTitle] = useState('');

  async function load() {
    const { data } = await api.get(`/api/v1/posts/${id}`);
    setTitle(data.title);
  }

  const save = async () => {
    await api.put(`/api/v1/posts/${id}`, { title });
  };

  return (
    <form onSubmit={save}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} onFocus={load} />
    </form>
  );
}
