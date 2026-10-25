'use server';

import { getCurrentUser, isAdmin, requireAdmin, requireUser } from '../../../lib/auth';

// authenticated: requireUser() redirects without a user
export async function updateProfile(input: { name: string }) {
  const user = await requireUser();
  return { id: user.id, name: input.name.trim() };
}

// authorization: requireAdmin() throws unless admin
export async function deleteAccount(id: string) {
  await requireAdmin();
  return { deleted: id };
}

// authorization: refuses anyone who is not an admin
export async function getAdminStats() {
  const user = await getCurrentUser();
  if (!user || !isAdmin(user)) return { error: 'Forbidden' };
  return { users: 10 };
}

// none: `role` comes from the form; checking it is validation, not authorization
export async function saveRoleRequest(input: { role: string }) {
  const role = input.role.trim();
  if (!role) return { error: 'Tell us your role.' };
  return { requested: role };
}

// none: a configured API key says nothing about the caller
export async function generateSummary(text: string) {
  if (!process.env.OPENAI_API_KEY) return { success: false, message: 'AI is not configured' };
  return { success: true, summary: text.slice(0, 100) };
}
