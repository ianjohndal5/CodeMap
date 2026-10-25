import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './util/jsonc.js';
import { normalizeRel, relPosix, toPosix } from './util/paths.js';

export function isLaravelRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'composer.json')) && fs.existsSync(path.join(dir, 'artisan'));
}

export function isNextRoot(dir: string): boolean {
  const pkg = readJsonFile(path.join(dir, 'package.json')) as Record<string, Record<string, string>> | null;
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next ?? pkg.peerDependencies?.next);
}

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.next', 'storage', 'dist', 'build', 'out', 'coverage']);

/** Find Laravel and Next.js roots below `root` (including root itself), breadth-first up to `maxDepth`. */
export function findProjects(root: string, maxDepth = 3): { laravel: string[]; next: string[] } {
  const laravel: string[] = [];
  const next: string[] = [];
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const nextLevel: string[] = [];
    for (const dir of level) {
      if (isLaravelRoot(dir)) laravel.push(dir);
      if (isNextRoot(dir)) next.push(dir);
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) nextLevel.push(path.join(dir, e.name));
      }
    }
    nextLevel.sort();
    level = nextLevel;
  }
  return { laravel, next };
}

export interface Roots {
  backend: string | null;
  frontend: string | null;
  warnings: string[];
}

/** Resolve the projects to analyze from CLI/config input. Throws with a user-facing message. */
export function resolveRoots(opts: { backend?: string; frontend?: string; root?: string }): Roots {
  const warnings: string[] = [];
  const checkDir = (p: string, flag: string) => {
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`${flag} path does not exist or is not a directory: ${p}`);
  };
  let backend = opts.backend ?? null;
  let frontend = opts.frontend ?? null;

  if (opts.root && (!backend || !frontend)) {
    checkDir(opts.root, '<root>');
    const found = findProjects(opts.root);
    if (!backend) {
      if (found.laravel.length > 1) {
        throw new Error(
          `Found several Laravel projects under ${opts.root}:\n  ${found.laravel.join('\n  ')}\nPass the one to analyze with --backend <path>.`,
        );
      }
      backend = found.laravel[0] ?? null;
    }
    if (!frontend) {
      if (found.next.length > 1) {
        throw new Error(
          `Found several Next.js projects under ${opts.root}:\n  ${found.next.join('\n  ')}\nPass the one to analyze with --frontend <path>.`,
        );
      }
      frontend = found.next[0] ?? null;
    }
    if (!backend && !frontend) {
      throw new Error(
        `No Laravel project (composer.json + artisan) or Next.js project (package.json with a "next" dependency) found under ${opts.root}.\n` +
          'Pass the projects explicitly: seammap --backend <laravelPath> --frontend <nextPath>',
      );
    }
  }
  if (!backend && !frontend) {
    throw new Error('Nothing to analyze. Usage: seammap --backend <laravelPath> --frontend <nextPath>  or  seammap <monorepoRoot>');
  }
  if (backend) {
    backend = path.resolve(backend);
    checkDir(backend, '--backend');
    if (!fs.existsSync(path.join(backend, 'composer.json'))) warnings.push(`${backend} has no composer.json; scanning app/ and routes/ with default PSR-4 (App\\ => app/).`);
    else if (!fs.existsSync(path.join(backend, 'artisan'))) warnings.push(`${backend} has no artisan file; it may not be a Laravel project.`);
  } else warnings.push('No Laravel backend given or detected; analyzing the frontend only.');
  if (frontend) {
    frontend = path.resolve(frontend);
    checkDir(frontend, '--frontend');
    if (!isNextRoot(frontend)) warnings.push(`${frontend} has no package.json with a "next" dependency; analyzing it as a Next.js project anyway.`);
  } else warnings.push('No Next.js frontend given or detected; analyzing the backend only.');
  if (backend && frontend && backend === frontend) {
    throw new Error(`Backend and frontend resolve to the same directory (${backend}). Pass them explicitly with --backend and --frontend.`);
  }
  return { backend, frontend, warnings };
}

// ---------------------------------------------------------------------------
// composer.json

export interface ComposerInfo {
  /** PSR-4 prefixes ("App\\") with directories relative to the backend root, longest prefix first. */
  psr4: { prefix: string; dirs: string[] }[];
  /** composer "files" autoload entries (relative). */
  files: string[];
}

export function readComposer(root: string, warnings: string[]): ComposerInfo {
  const file = path.join(root, 'composer.json');
  const json = fs.existsSync(file) ? (readJsonFile(file) as Record<string, any> | null) : null;
  if (!json) {
    if (fs.existsSync(file)) warnings.push(`Could not parse ${file}; using default PSR-4 mapping App\\ => app/.`);
    return { psr4: [{ prefix: 'App\\', dirs: ['app'] }], files: [] };
  }
  const psr4: ComposerInfo['psr4'] = [];
  const raw = (json.autoload?.['psr-4'] ?? {}) as Record<string, string | string[]>;
  for (const [prefix, dirs] of Object.entries(raw)) {
    const list = (Array.isArray(dirs) ? dirs : [dirs])
      .map((d) => normalizeRel(toPosix(d)))
      .filter((d): d is string => d !== null);
    psr4.push({ prefix, dirs: list.length ? list : [''] });
  }
  if (psr4.length === 0) {
    warnings.push('composer.json has no autoload.psr-4 section; using App\\ => app/.');
    psr4.push({ prefix: 'App\\', dirs: ['app'] });
  }
  psr4.sort((a, b) => b.prefix.length - a.prefix.length || (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  const files = ((json.autoload?.files ?? []) as string[])
    .map((f) => normalizeRel(toPosix(f)))
    .filter((f): f is string => f !== null);
  return { psr4, files };
}

// ---------------------------------------------------------------------------
// tsconfig.json / jsconfig.json

export interface TsPaths {
  /** Directory (relative to the frontend root, '' = root) that `paths` targets are relative to. */
  baseDir: string;
  /** Whether bare specifiers may resolve against baseDir (only when baseUrl is set). */
  hasBaseUrl: boolean;
  paths: { pattern: string; targets: string[] }[];
}

/** Read compilerOptions.baseUrl/paths, following relative "extends" chains. */
export function readTsPaths(root: string, warnings: string[]): TsPaths {
  const candidates = ['tsconfig.json', 'jsconfig.json'].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
  if (candidates.length === 0) {
    warnings.push(`No tsconfig.json or jsconfig.json in ${root}; path aliases such as @/ will not resolve.`);
    return { baseDir: '', hasBaseUrl: false, paths: [] };
  }
  let baseUrl: string | undefined;
  let pathsDir: string | undefined;
  let paths: Record<string, string[]> | undefined;
  const seen = new Set<string>();
  // Walk the extends chain; the most-derived config wins for each option.
  let current: string | undefined = candidates[0];
  while (current && !seen.has(current)) {
    seen.add(current);
    const json = readJsonFile(current) as Record<string, any> | null;
    if (!json) {
      warnings.push(`Could not parse ${current}; ignoring it.`);
      break;
    }
    const co = json.compilerOptions ?? {};
    const dir = path.dirname(current);
    if (baseUrl === undefined && typeof co.baseUrl === 'string') baseUrl = path.resolve(dir, co.baseUrl);
    if (paths === undefined && co.paths && typeof co.paths === 'object') {
      paths = co.paths;
      pathsDir = dir;
    }
    const ext = typeof json.extends === 'string' && json.extends.startsWith('.') ? path.resolve(dir, json.extends) : undefined;
    current = ext && !ext.endsWith('.json') && !fs.existsSync(ext) ? ext + '.json' : ext;
  }
  // Without baseUrl, TypeScript resolves `paths` relative to the config file that declares them.
  const base = baseUrl ?? pathsDir ?? root;
  const baseDir = relPosix(root, base);
  return {
    baseDir: baseDir === '' ? '' : baseDir,
    hasBaseUrl: baseUrl !== undefined,
    paths: Object.entries(paths ?? {}).map(([pattern, targets]) => ({
      pattern,
      targets: (Array.isArray(targets) ? targets : []).map((t) => toPosix(t)),
    })),
  };
}
