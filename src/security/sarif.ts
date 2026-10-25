import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SARIF 2.1.0 import. CodeMap only reads results the user produced with their own scanners
// (Semgrep, CodeQL, Psalm, ESLint...); nothing is executed here.

export type Level = 'error' | 'warning' | 'note' | 'none';

/** One SARIF result, before it is placed on the graph. */
export interface RawFinding {
  tool: string;
  ruleId: string;
  ruleName?: string;
  level: Level;
  /** `security-severity` (0-10) from the result or its rule, when the tool provides it. */
  severity?: number;
  message: string;
  /** Location as written in the SARIF file, resolved against uriBaseIds when possible. */
  uri: string | null;
  line?: number;
  endLine?: number;
  column?: number;
  suppressed: boolean;
  /** SARIF file the result came from (as given on the command line). */
  source: string;
}

export interface SarifFile {
  file: string;
  tools: string[];
  results: RawFinding[];
  error?: string;
}

type Json = Record<string, any>;

const LEVELS = new Set(['error', 'warning', 'note', 'none']);

/** Read one SARIF file. Never throws: problems are reported in `error`. */
export function readSarif(file: string): SarifFile {
  const out: SarifFile = { file, tools: [], results: [] };
  let doc: Json;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    out.error = `could not read SARIF: ${(e as Error).message}`;
    return out;
  }
  if (!doc || !Array.isArray(doc.runs)) {
    out.error = 'not a SARIF log (no "runs" array)';
    return out;
  }
  for (const run of doc.runs as Json[]) {
    const driver = run?.tool?.driver ?? {};
    const tool = String(driver.name ?? 'unknown tool');
    if (!out.tools.includes(tool)) out.tools.push(tool);
    const rules: Json[] = [...(driver.rules ?? []), ...(run?.tool?.extensions ?? []).flatMap((x: Json) => x?.rules ?? [])];
    const byId = new Map<string, Json>(rules.filter((r) => r?.id).map((r) => [String(r.id), r]));
    const bases: Json = run.originalUriBaseIds ?? {};
    const artifacts: Json[] = run.artifacts ?? [];
    for (const r of (run.results ?? []) as Json[]) {
      if (!r || (r.kind && r.kind !== 'fail' && r.kind !== 'open' && r.kind !== 'review')) continue;
      const rule: Json | undefined = (r.ruleId && byId.get(String(r.ruleId))) ?? (Number.isInteger(r.ruleIndex) ? rules[r.ruleIndex] : undefined) ?? (r.rule?.id ? byId.get(String(r.rule.id)) : undefined);
      const ruleId = String(r.ruleId ?? rule?.id ?? r.rule?.id ?? 'unknown-rule');
      const levelRaw = r.level ?? rule?.defaultConfiguration?.level ?? 'warning';
      const sev = Number.parseFloat(r.properties?.['security-severity'] ?? rule?.properties?.['security-severity']);
      const loc = (r.locations ?? [])[0]?.physicalLocation ?? {};
      const art = loc.artifactLocation ?? {};
      const uriRaw = art.uri ?? (Number.isInteger(art.index) ? artifacts[art.index]?.location?.uri : undefined);
      const baseId = art.uriBaseId ?? (Number.isInteger(art.index) ? artifacts[art.index]?.location?.uriBaseId : undefined);
      const region = loc.region ?? {};
      out.results.push({
        tool,
        ruleId,
        ...(rule?.name ? { ruleName: String(rule.name) } : {}),
        level: LEVELS.has(levelRaw) ? levelRaw : 'warning',
        ...(Number.isFinite(sev) ? { severity: sev } : {}),
        message: messageOf(r, rule),
        uri: typeof uriRaw === 'string' ? withBase(uriRaw, baseId, bases) : null,
        ...(Number.isInteger(region.startLine) ? { line: region.startLine } : {}),
        ...(Number.isInteger(region.endLine) ? { endLine: region.endLine } : {}),
        ...(Number.isInteger(region.startColumn) ? { column: region.startColumn } : {}),
        suppressed: Array.isArray(r.suppressions) && r.suppressions.some((s: Json) => s?.status !== 'rejected'),
        source: file,
      });
    }
  }
  return out;
}

function messageOf(r: Json, rule: Json | undefined): string {
  let text: string | undefined = r.message?.text ?? r.message?.markdown;
  if (!text && r.message?.id && rule?.messageStrings?.[r.message.id]) text = rule.messageStrings[r.message.id].text;
  if (!text) text = rule?.shortDescription?.text ?? rule?.fullDescription?.text ?? '';
  const args: unknown[] = r.message?.arguments ?? [];
  return String(text)
    .replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m))
    .trim();
}

/** Apply `originalUriBaseIds` (one level of nesting is enough in practice). */
function withBase(uri: string, baseId: string | undefined, bases: Json, depth = 0): string {
  if (!baseId || depth > 3 || /^[a-z]+:/i.test(uri)) return uri;
  const base = bases[baseId];
  if (!base?.uri) return uri;
  const joined = String(base.uri).replace(/\/?$/, '/') + uri.replace(/^\.?\//, '');
  return withBase(joined, base.uriBaseId, bases, depth + 1);
}

export interface FileMatch {
  side: 'backend' | 'frontend';
  rel: string;
}

/**
 * Map a SARIF URI to a scanned file. Absolute paths are made relative to a project root;
 * relative ones are tried as-is against both projects, then by unique path suffix (scanners
 * often run from a monorepo root).
 */
export function matchFile(
  uri: string,
  roots: { backend: string | null; frontend: string | null },
  files: { backend: Set<string>; frontend: Set<string> },
): FileMatch | { reason: string } {
  let p = uri;
  if (/^file:/i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return { reason: 'unreadable file URI' };
    }
  } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) {
    return { reason: 'non-file URI' };
  } else {
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep as written
    }
  }
  p = p.split(path.sep).join('/');
  const sides = ['backend', 'frontend'] as const;
  if (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    // One project may live inside the other (monorepo): prefer the side that has the file.
    let inside = false;
    for (const side of sides) {
      const root = roots[side];
      if (!root) continue;
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      inside = true;
      if (files[side].has(rel)) return { side, rel };
    }
    return { reason: inside ? 'file not among the analyzed sources' : 'outside both projects' };
  }
  const clean = p.replace(/^(\.\/)+/, '');
  for (const side of sides) if (files[side].has(clean)) return { side, rel: clean };
  // Suffix match in either direction ("web/src/app/page.tsx" vs "src/app/page.tsx"); must be unique.
  const hits: FileMatch[] = [];
  for (const side of sides) {
    for (const rel of files[side]) if (clean.endsWith('/' + rel) || rel.endsWith('/' + clean)) hits.push({ side, rel });
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // Prefer the longest overlap; still ambiguous when two share it.
    const best = Math.max(...hits.map((h) => Math.min(h.rel.length, clean.length)));
    const top = hits.filter((h) => Math.min(h.rel.length, clean.length) === best);
    return top.length === 1 ? top[0] : { reason: `ambiguous path (${hits.length} candidates)` };
  }
  return { reason: 'file not among the analyzed sources' };
}
