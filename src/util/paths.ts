import path from 'node:path';

/** Convert to forward slashes so IDs and globs are identical on every OS. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Relative POSIX path from root to file. */
export function relPosix(root: string, file: string): string {
  return toPosix(path.relative(root, file));
}

/** Normalize a POSIX relative path ("a/./b/../c" -> "a/c"). Returns null if it escapes the root. */
export function normalizeRel(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function dirnamePosix(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function joinPosix(...parts: string[]): string {
  return parts.filter((x) => x !== '').join('/');
}
