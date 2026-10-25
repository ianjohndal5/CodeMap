'use client';

export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <p>{error.message}</p>
      <button onClick={() => reset()}>Retry</button>
    </div>
  );
}
