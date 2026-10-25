import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import ignore, { type Ignore } from 'ignore';
import type { CodemapConfig } from './config.js';
import type { ComposerInfo } from './detect.js';
import { dirnamePosix } from './util/paths.js';

/** Directories never scanned on the Laravel side. */
export const LARAVEL_SKIP = [
  'vendor/**',
  'storage/**',
  'bootstrap/cache/**',
  'public/**',
  'node_modules/**',
  'database/**',
  'config/**',
  'tests/**',
  'resources/views/**',
  'routes/console.php',
  'routes/channels.php',
];

/** Paths never scanned on the Next.js side. */
export const NEXT_SKIP = [
  '**/node_modules/**',
  '**/.next/**',
  'out/**',
  '**/build/**',
  '**/dist/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.min.mjs',
  '**/*.d.ts',
];

const FAST_GLOB_SKIP = ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/.next/**'];

/** Loads every .gitignore in the project and answers "is this relative path ignored?". */
class GitIgnore {
  private rules: { dir: string; ig: Ignore }[] = [];

  constructor(root: string) {
    const files = fg.sync('**/.gitignore', { cwd: root, dot: true, ignore: FAST_GLOB_SKIP });
    files.sort();
    for (const f of files) {
      try {
        const ig = ignore().add(fs.readFileSync(path.join(root, f), 'utf8'));
        this.rules.push({ dir: dirnamePosix(f), ig });
      } catch {
        // Unreadable .gitignore: ignore it.
      }
    }
  }

  ignores(rel: string): boolean {
    for (const { dir, ig } of this.rules) {
      if (dir === '') {
        if (ig.ignores(rel)) return true;
      } else if (rel.startsWith(dir + '/')) {
        if (ig.ignores(rel.slice(dir.length + 1))) return true;
      }
    }
    return false;
  }
}

function finalize(root: string, files: string[], skip: string[], exclude: string[]): string[] {
  const gi = new GitIgnore(root);
  const skipper = ignore().add(skip).add(exclude);
  const out = new Set<string>();
  for (const f of files) {
    if (skipper.ignores(f) || gi.ignores(f)) continue;
    out.add(f);
  }
  return [...out].sort();
}

/** PHP files to analyze: PSR-4 source roots + routes/, relative POSIX paths, sorted. */
export function scanLaravel(root: string, composer: ComposerInfo, config: CodemapConfig): string[] {
  const dirs = new Set<string>(['routes']);
  for (const { dirs: ds } of composer.psr4) for (const d of ds) dirs.add(d);
  const patterns: string[] = [];
  for (const d of dirs) patterns.push(d === '' ? '**/*.php' : `${d}/**/*.php`);
  for (const f of composer.files) patterns.push(f);
  patterns.push(...config.laravel.include);
  const files = fg.sync(patterns, { cwd: root, dot: false, onlyFiles: true, ignore: FAST_GLOB_SKIP });
  return finalize(root, files, LARAVEL_SKIP, config.laravel.exclude);
}

/** JS/TS files of the Next.js project, relative POSIX paths, sorted. */
export function scanNext(root: string, config: CodemapConfig): string[] {
  const patterns = ['**/*.{js,jsx,ts,tsx,mjs,cjs}', ...config.next.include];
  const files = fg.sync(patterns, { cwd: root, dot: false, onlyFiles: true, ignore: FAST_GLOB_SKIP });
  return finalize(root, files, NEXT_SKIP, config.next.exclude);
}
