import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from './brand.js';
import { parseJsonc } from './util/jsonc.js';

export interface LaravelOptions {
  /** Prefix applied to routes/api.php. Default "/api" (or bootstrap/app.php apiPrefix). */
  apiPrefix?: string;
  /** Extra globs (relative to the backend root) to scan. */
  include: string[];
  /** Globs (relative to the backend root) to skip. */
  exclude: string[];
  /** Namespace used for unqualified 'Controller@method' actions. */
  controllerNamespace?: string;
}

export interface NextOptions {
  include: string[];
  exclude: string[];
  /**
   * Env var names holding the backend base URL. Empty = any process.env.* /
   * import.meta.env.* at the start of a URL is treated as the backend.
   */
  backendEnvVars: string[];
  /** Identifier names (e.g. API_URL) treated as the backend base URL when they cannot be resolved. */
  baseUrlVariables: string[];
  /** host[:port] values of absolute URLs that point at the Laravel backend. localhost/127.0.0.1 always count. */
  backendHosts: string[];
  /**
   * Path the backend base URL carries, when it lives in .env (which SeamMap never reads):
   * "/api" for every base, or per variable, e.g. { "NEXT_PUBLIC_API_URL": "/api" }.
   */
  backendBasePath?: string | Record<string, string>;
}

/**
 * Security lens (--security). Each list names middleware by alias ('tenant'), alias with
 * parameters ('role:admin'), group name or class FQN; matching is case-insensitive.
 */
export interface SecurityOptions {
  /** Treated as authentication (blocks anonymous requests). */
  authMiddleware: string[];
  /** Treated as an authorization check. */
  authorizationMiddleware: string[];
  /** Treated as explicitly public (like guest). */
  publicMiddleware: string[];
  /** Known not to restrict access (logging, locale, headers...). */
  ignoreMiddleware: string[];
  /** SARIF files to import (relative to the config file); --sarif adds more. */
  sarif: string[];
  /** Run SeamMap's local pattern checks (default true). */
  checks: boolean;
  /** Check ids to skip, e.g. "js.token-in-web-storage". */
  disableChecks: string[];
}

export interface CodemapConfig {
  backend?: string;
  frontend?: string;
  laravel: LaravelOptions;
  next: NextOptions;
  security: SecurityOptions;
  /** The file these settings were read from (set by loadConfig): graph.json records it in meta.config. */
  source?: { file: string; sha256: string };
}

export function defaultConfig(): CodemapConfig {
  return {
    laravel: { include: [], exclude: [] },
    next: { include: [], exclude: [], backendEnvVars: [], baseUrlVariables: [], backendHosts: [] },
    security: { authMiddleware: [], authorizationMiddleware: [], publicMiddleware: [], ignoreMiddleware: [], sarif: [], checks: true, disableChecks: [] },
  };
}

function strArray(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`config: "${what}" must be an array of strings`);
  }
  return v as string[];
}

function basePathOption(v: unknown): string | Record<string, string> | undefined {
  if (v === undefined || typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')) return v as Record<string, string>;
  throw new Error('config: "next.backendBasePath" must be a path string or an object of variable name -> path');
}

function optBool(v: unknown, what: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`config: "${what}" must be true or false`);
  return v;
}

function optString(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`config: "${what}" must be a string`);
  return v;
}

/** Where the config search starts: a project root (or the monorepo root, or the current folder), named for people. */
export interface ConfigStart {
  dir: string;
  /** "backend root", "frontend root", "monorepo root", "current folder". */
  label: string;
  /** Set for project roots: a config whose `backend` / `frontend` names this folder is preferred. */
  role?: 'backend' | 'frontend';
}

export interface ConfigLookup {
  /** The config file to use, or null for the defaults. */
  file: string | null;
  /** Why this file, for people: "in the frontend root", "1 folder above the frontend root; it names these projects", or "none found". */
  how: string;
  /** The folders looked in, in order. */
  searched: string[];
  /** Config files found from another start but not used. */
  others: string[];
}

/** The folders a search from `start` covers: up to its repository root (the first folder with .git), else up to `outside`. */
function searchChain(start: string, outside: string): string[] {
  const chain: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    chain.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) return chain;
    if (path.dirname(dir) === dir) break;
  }
  // Not in a git repository: stop at the folder that holds all the projects being analyzed.
  const stop = chain.indexOf(outside);
  return chain.slice(0, stop === -1 ? 1 : stop + 1);
}

/** The deepest folder containing every path (a filesystem root when they share none, e.g. two Windows drives). */
function commonAncestor(dirs: string[]): string {
  let common = dirs[0]!;
  const inside = (d: string) => {
    const rel = path.relative(common, d);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  for (const d of dirs.slice(1)) while (!inside(d) && path.dirname(common) !== common) common = path.dirname(common);
  return common;
}

/** How many of the project roots a config file names in its `backend` / `frontend` (0 when it can't be read). */
function namedRoots(file: string, starts: ConfigStart[]): number {
  let raw: Record<string, unknown>;
  try {
    raw = parseJsonc(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return 0;
  }
  const dir = path.dirname(file);
  return starts.filter((s) => s.role && typeof raw[s.role] === 'string' && path.relative(path.resolve(dir, raw[s.role] as string), path.resolve(s.dir)) === '').length;
}

/**
 * The config file that belongs to the projects, independent of the current directory: the nearest
 * seammap.config.json in or above each start folder, up to the repository root (outside a git repository, up
 * to the folder holding all the starts). When several starts find different files, the one whose `backend` /
 * `frontend` names the most of the projects wins, then the closest, then the earlier start (backend first).
 */
export function findConfig(starts: ConfigStart[]): ConfigLookup {
  const outside = commonAncestor(starts.map((s) => path.resolve(s.dir)));
  const searched: string[] = [];
  const found: { file: string; distance: number; order: number; start: ConfigStart; names: number }[] = [];
  for (const [order, start] of starts.entries()) {
    const chain = searchChain(path.resolve(start.dir), outside);
    for (const [distance, dir] of chain.entries()) {
      if (!searched.includes(dir)) searched.push(dir);
      const file = path.join(dir, CONFIG_FILE);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        if (!found.some((f) => f.file === file)) found.push({ file, distance, order, start, names: 0 });
        break;
      }
    }
  }
  if (!found.length) return { file: null, how: 'none found', searched, others: [] };
  if (found.length > 1) for (const f of found) f.names = namedRoots(f.file, starts);
  found.sort((a, b) => b.names - a.names || a.distance - b.distance || a.order - b.order);
  const best = found[0]!;
  let how = best.distance === 0 ? `in the ${best.start.label}` : `${best.distance} folder${best.distance === 1 ? '' : 's'} above the ${best.start.label}`;
  if (found.length > 1) how += best.names > found[1]!.names ? '; it names these projects' : best.distance < found[1]!.distance ? '; the closest' : '; as close as another, and the backend comes first';
  return { file: best.file, how, searched, others: found.slice(1).map((f) => f.file) };
}

/** JSON with object keys sorted at every level, so that equal settings give equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Load seammap.config.json. `explicit` is a path (relative to `cwd`) that must exist; without it, the file in
 * `cwd` is used when present (the CLI picks the file with findConfig instead). Relative paths inside it resolve
 * against the config file's directory.
 */
export function loadConfig(explicit: string | undefined, cwd: string): { config: CodemapConfig; file: string | null } {
  const config = defaultConfig();
  const file = explicit ? path.resolve(cwd, explicit) : path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    if (explicit) throw new Error(`Config file not found: ${file}`);
    return { config, file: null };
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseJsonc(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Could not parse ${file}: ${(e as Error).message}`);
  }
  // The parsed settings, not the bytes: comments, formatting, key order and line endings don't change it.
  config.source = { file, sha256: createHash('sha256').update(canonical(raw)).digest('hex') };
  const dir = path.dirname(file);
  const backend = optString(raw.backend, 'backend');
  const frontend = optString(raw.frontend, 'frontend');
  if (backend) config.backend = path.resolve(dir, backend);
  if (frontend) config.frontend = path.resolve(dir, frontend);

  const lv = (raw.laravel ?? {}) as Record<string, unknown>;
  config.laravel = {
    apiPrefix: optString(lv.apiPrefix, 'laravel.apiPrefix'),
    include: strArray(lv.include, 'laravel.include'),
    exclude: strArray(lv.exclude, 'laravel.exclude'),
    controllerNamespace: optString(lv.controllerNamespace, 'laravel.controllerNamespace'),
  };
  const nx = (raw.next ?? {}) as Record<string, unknown>;
  config.next = {
    include: strArray(nx.include, 'next.include'),
    exclude: strArray(nx.exclude, 'next.exclude'),
    backendEnvVars: strArray(nx.backendEnvVars, 'next.backendEnvVars'),
    baseUrlVariables: strArray(nx.baseUrlVariables, 'next.baseUrlVariables'),
    backendHosts: strArray(nx.backendHosts, 'next.backendHosts'),
    backendBasePath: basePathOption(nx.backendBasePath),
  };
  const sec = (raw.security ?? {}) as Record<string, unknown>;
  config.security = {
    authMiddleware: strArray(sec.authMiddleware, 'security.authMiddleware'),
    authorizationMiddleware: strArray(sec.authorizationMiddleware, 'security.authorizationMiddleware'),
    publicMiddleware: strArray(sec.publicMiddleware, 'security.publicMiddleware'),
    ignoreMiddleware: strArray(sec.ignoreMiddleware, 'security.ignoreMiddleware'),
    sarif: strArray(sec.sarif, 'security.sarif').map((f) => path.resolve(dir, f)),
    checks: optBool(sec.checks, 'security.checks') ?? true,
    disableChecks: strArray(sec.disableChecks, 'security.disableChecks'),
  };
  return { config, file };
}
