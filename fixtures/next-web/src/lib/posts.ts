import api from './axios';

export const postsApi = {
  list: () => api.get('api/v1/posts'),
  get: (id: string) => api.get(`/api/v1/posts/${id}`),
};
