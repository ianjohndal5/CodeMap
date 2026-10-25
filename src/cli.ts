#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { analyze } from './analyze.js';
import { COMMAND, CONFIG_FILE, DISPLAY_NAME, OUT_DIR, VERSION } from './brand.js';
import { defaultConfig, findConfig, loadConfig } from './config.js';
import type { ConfigLookup, ConfigStart } from './config.js';
import { resolveRoots } from './detect.js';
import { serve } from './server.js';
import type { Graph } from './types.js';

interface CliOptions {
  backend?: string;
  frontend?: string;
  config?: string;
  out: string;
  port: string;
  open: boolean;
  jsonOnly?: boolean;
  list?: boolean;
  security?: boolean;
  sarif?: string[];
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

function printSummary(graph: Graph, outFile: string, lookup: ConfigLookup, cwd: string): void {
  const { stats, timings, durationMs, backendRoot, frontendRoot } = graph.meta;
  const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(22)} ${value}`);
  // Relative to where the command ran, unless that is longer than the absolute path.
  const shown = (p: string) => {
    const rel = path.relative(cwd, p) || '.';
    return rel.length <= p.length ? rel : p;
  };
  console.log('');
  console.log(`${DISPLAY_NAME} ${VERSION}`);
  line('backend', backendRoot ?? '(none)');
  line('frontend', frontendRoot ?? '(none)');
  line('config', lookup.file ? `${shown(lookup.file)} (${lookup.how})` : `none, defaults used (looked for ${CONFIG_FILE} in ${lookup.searched.map(shown).join(', ')})`);
  line('files', stats.files);
  line('definitions', stats.definitions);
  line('edges', `${stats.edges} (${stats.uncertainEdges} uncertain)`);
  line('endpoints', stats.endpoints);
  line('http calls', stats.httpCalls);
  line('unmatched http calls', stats.unmatchedHttpCalls);
  line('unmatched endpoints', frontendRoot ? stats.unmatchedEndpoints : '- (no frontend analyzed, so no callers to match)');
  line('unresolved calls', stats.unresolvedCalls);
  line('unresolved imports', stats.unresolvedImports);
  line('unresolved handlers', stats.unresolvedHandlers);
  line('parse errors', stats.parseErrors);
  console.log(
    `  timings (ms)           scan ${timings.scan} | parse ${timings.parse} | extract ${timings.extract} | resolve ${timings.resolve} | link ${timings.link}${timings.security !== undefined ? ` | security ${timings.security}` : ''} | total ${durationMs}`,
  );
  if (graph.security) printSecurity(graph.security, lookup.file ? shown(lookup.file) : `a new ${CONFIG_FILE} in the ${backendRoot ? 'backend' : 'frontend'} root`);
  line('graph', outFile);
  const warnings = graph.meta.warnings;
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, 15)) console.log(`  - ${w}`);
    if (warnings.length > 15) console.log(`  ... ${warnings.length - 15} more in graph.json (meta.warnings)`);
  }
}

/** The "security" part of a config, unresolved names under ignoreMiddleware for the user to move (as in the viewer). */
function configSnippet(names: string[]): string {
  return JSON.stringify({ security: { ignoreMiddleware: names, authMiddleware: [], authorizationMiddleware: [], publicMiddleware: [] } }, null, 2);
}

function printSecurity(sec: NonNullable<Graph['security']>, configWhere: string): void {
  const s = sec.summary;
  console.log('\nSecurity lens (review aid: shows where to look, certifies nothing)');
  // When a few middleware are all that keeps most unknowns unknown, that is the step to take first.
  const lead = sec.classifyFirst;
  if (lead) {
    console.log(`  First step: classify ${lead.middleware.length} middleware to resolve ${lead.endpoints} of the ${s.unknown} unknown endpoints. Read each one, then list it in ${configWhere}:`);
    for (const name of lead.middleware) {
      const u = sec.middleware.unresolved.find((r) => r.name === name);
      console.log(`    ${name} (on ${u?.decisive ?? 0} unknown endpoints)${u?.hint ? ` - ${u.hint}` : ''}`);
    }
    for (const l of configSnippet(lead.middleware).split('\n')) console.log(`      ${l}`);
    console.log('    Move each name to the list that matches what it does. States change only once you classify them.');
  }
  console.log(`  authorization check seen ${s.authorization} | authenticated ${s.authenticated} | signed URL ${s.signed} | public (guest) ${s.public} | unknown ${s.unknown} | no protection found ${s.none}`);
  for (const r of sec.unknownReasons.slice(0, 5)) console.log(`  unknown: ${r.endpoints} x ${r.label}`);
  const top = lead ? [] : sec.middleware.unresolved.filter((u) => u.decisive > 0).slice(0, 5);
  if (top.length) {
    console.log(`  classify these in ${CONFIG_FILE} "security" to resolve unknowns:`);
    for (const u of top) console.log(`    ${u.name} (${u.decisive} endpoint(s))${u.hint ? ` - ${u.hint}` : ''}`);
  }
  for (const c of sec.caveats) console.log(`  note: ${c}`);
  for (const i of sec.imports) {
    console.log(`  sarif: ${path.basename(i.file)} (${i.tools.join(', ') || 'no runs'}): ${i.results} results, ${i.placed} placed on the map, ${i.outside} outside it${i.suppressed ? `, ${i.suppressed} suppressed` : ''}${i.error ? ` - ${i.error}` : ''}`);
  }
  const checks = sec.findings.filter((f) => f.origin === 'check');
  if (sec.checks.rules.length) console.log(`  local checks: ${checks.length} hit(s) across ${sec.checks.rules.length} rule(s)`);
  const reached = sec.findings.filter((f) => f.endpointCount > 0).length;
  if (sec.findings.length) console.log(`  findings reached from an endpoint through known calls: ${reached} of ${sec.findings.length}`);
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name(COMMAND)
    .description('Deterministic Laravel <-> Next.js codebase visualizer')
    .version(VERSION)
    .argument('[root]', 'monorepo root containing both projects (auto-detected)')
    .option('-b, --backend <path>', 'Laravel project root')
    .option('-f, --frontend <path>', 'Next.js project root')
    .option('-c, --config <file>', `config file (default: the nearest ${CONFIG_FILE} in or above the projects)`)
    .option('-o, --out <dir>', 'output directory for graph.json', OUT_DIR)
    .option('-p, --port <n>', 'viewer port', '5178')
    .option('--no-open', 'do not open the browser')
    .option('--json-only', 'write graph.json and exit without serving')
    .option('--list', 'print every definition and route with file:line, then exit')
    .option('--security', 'add the security lens: route protection signals for review (not a scanner)')
    .option('--sarif <files...>', 'import SARIF results from your own scanners (implies --security)')
    .showHelpAfterError();
  program.parse();
  const opts = program.opts<CliOptions>();
  const root = program.args[0];
  const cwd = process.cwd();

  const named = {
    backend: opts.backend ? path.resolve(cwd, opts.backend) : undefined,
    frontend: opts.frontend ? path.resolve(cwd, opts.frontend) : undefined,
    root: root ? path.resolve(cwd, root) : undefined,
  };
  // The config that belongs to the named projects, wherever the command runs (README: Configuration).
  const starts: ConfigStart[] = [];
  if (named.backend) starts.push({ dir: named.backend, label: 'backend root', role: 'backend' });
  if (named.frontend) starts.push({ dir: named.frontend, label: 'frontend root', role: 'frontend' });
  if (named.root) starts.push({ dir: named.root, label: 'monorepo root' });
  if (!starts.length) starts.push({ dir: cwd, label: 'current folder' });
  const lookup: ConfigLookup = opts.config
    ? { file: path.resolve(cwd, opts.config), how: 'given with --config', searched: [], others: [] }
    : findConfig(starts);
  const { config } = lookup.file ? loadConfig(lookup.file, cwd) : { config: defaultConfig() };
  const warnings: string[] = [];
  for (const other of lookup.others) warnings.push(`Also found ${other}, not used (see "config" above; pass --config to choose).`);
  const roots = resolveRoots({
    backend: named.backend ?? config.backend,
    frontend: named.frontend ?? config.frontend,
    root: named.root,
  });
  warnings.push(...roots.warnings);

  for (const f of opts.sarif ?? []) config.security.sarif.push(path.resolve(cwd, f));
  const security = Boolean(opts.security || opts.sarif?.length);
  const { graph, adapters } = analyze({ backend: roots.backend, frontend: roots.frontend, config, warnings, security });

  if (opts.list) {
    for (const a of adapters) {
      console.log(`\n# ${a.side}: ${a.root}`);
      for (const l of a.listDefinitions()) console.log(l);
    }
  }

  const outDir = path.resolve(cwd, opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'graph.json');
  fs.writeFileSync(outFile, JSON.stringify(graph, null, 1));
  printSummary(graph, outFile, lookup, cwd);

  if (opts.jsonOnly || opts.list) return;
  const port = Number.parseInt(opts.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid --port: ${opts.port}`);
  const { url } = await serve({ graphFile: outFile, port });
  console.log(`\nViewer: ${url}  (Ctrl+C to stop)`);
  if (opts.open) openBrowser(url);
}

main().catch((err: Error) => {
  console.error(`${COMMAND}: ${err.message}`);
  process.exit(1);
});
