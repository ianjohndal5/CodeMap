// SWR-style fetcher: the URL is only known at runtime (unmatched, dynamic).
export const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Unknown base URL: matched by static suffix, marked uncertain.
export function getPostsFrom(base: string) {
  return fetch(`${base}/api/v1/posts`).then((r) => r.json());
}
