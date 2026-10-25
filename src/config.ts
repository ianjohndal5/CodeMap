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
   * Path the backend base URL carries, when it lives in .env (which CodeMap never reads):
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
  /** Run CodeMap's local pattern checks (default true). */
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

/**
 * Load codemap.config.json. `explicit` is the --config path; otherwise the file is
 * looked up in the current directory and silently skipped when absent.
 * Relative backend/frontend paths are resolved against the config file's directory.
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
