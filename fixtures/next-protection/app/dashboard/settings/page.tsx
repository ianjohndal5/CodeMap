import { SettingsForm } from './SettingsForm';

export default function SettingsPage() {
  async function rename(data: FormData) {
    'use server';
    console.log(data.get('name'));
  }
  return (
    <main>
      <SettingsForm />
      <form action={rename} />
    </main>
  );
}
