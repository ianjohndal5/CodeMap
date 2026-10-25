import axios from 'axios';

export const api = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL });

export async function signup(email: string, password: string) {
  const { data } = await api.post('/api/signup', { email, password });
  // flagged: a bearer token in localStorage
  localStorage.setItem('auth_token', data.token);
  // not flagged: not a token, or tracking state that only mentions a session
  localStorage.setItem('theme', data.theme);
  sessionStorage.setItem('analytics_session_id', data.visit);
  return data;
}

// flagged: a secret-looking NEXT_PUBLIC_ variable; the publishable key is fine
export const stripeSecret = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;
export const stripePublishable = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
