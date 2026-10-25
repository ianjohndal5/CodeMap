import api from '@/lib/axios';

export type User = { id: number; name: string; email: string };

export async function listUsers(): Promise<User[]> {
  const { data } = await api.get('/api/v1/users');
  return data.data;
}

export const createUser = (input: Omit<User, 'id'>) => api.post('/api/v1/users', input);

export function logout() {
  return api.post('/logout');
}
