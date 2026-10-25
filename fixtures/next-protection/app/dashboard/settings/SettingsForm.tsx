'use client';

import { updateProfile } from './actions';

export function SettingsForm() {
  return (
    <form action={async (data: FormData) => { await updateProfile({ name: String(data.get('name')) }); }}>
      <input name="name" />
    </form>
  );
}
