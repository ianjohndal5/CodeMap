// The graph.json format version, and the compatibility check every reader shares: the viewer (the server
// serves the compiled file as /schema.js), the programmatic API and the editor extension. No Node imports.

/**
 * Version of the graph.json format, written as its top-level `schemaVersion`. It increases only when a reader
 * written for the previous version would misread a file: a field removed or renamed, or a field's type,
 * meaning or ID format changed. Additions (new fields, new values in an enumeration) never change it.
 */
export const SCHEMA_VERSION = 1;

export interface SchemaProblem {
  /**
   * invalid: not a graph.json. missing: no schemaVersion (an unversioned development build, or another tool).
   * newer / older: another format version than this one reads.
   */
  kind: 'invalid' | 'missing' | 'newer' | 'older';
  /** What is wrong and what to do, for people. */
  message: string;
}

/** Whether this version can read a parsed graph.json: null when it can, otherwise why not. */
export function checkSchema(graph: unknown): SchemaProblem | null {
  const g = graph as { schemaVersion?: unknown; meta?: { version?: unknown }; nodes?: unknown } | null;
  if (!g || typeof g !== 'object' || !Array.isArray(g.nodes)) {
    return { kind: 'invalid', message: 'This file is not a graph.json written by CodeMap.' };
  }
  const writer = typeof g.meta?.version === 'string' ? `CodeMap ${g.meta.version}` : 'an unknown version of CodeMap';
  const v = g.schemaVersion;
  if (v === undefined) {
    return {
      kind: 'missing',
      message: `This graph.json has no format version (it says it was written by ${writer}), so it comes from a development build or another tool. Run codemap again to regenerate it.`,
    };
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return { kind: 'invalid', message: `This graph.json has an invalid format version (${JSON.stringify(v)}). Run codemap again to regenerate it.` };
  }
  if (v > SCHEMA_VERSION) {
    return {
      kind: 'newer',
      message: `This graph.json uses format version ${v}, written by ${writer}, but this version of CodeMap reads format version ${SCHEMA_VERSION}. Update CodeMap to open it, or run the codemap you have again to regenerate it.`,
    };
  }
  if (v < SCHEMA_VERSION) {
    return {
      kind: 'older',
      message: `This graph.json uses format version ${v}, written by ${writer}, but this version of CodeMap reads format version ${SCHEMA_VERSION}. Run codemap again to regenerate it.`,
    };
  }
  return null;
}
