#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { analyze } from './analyze.js';
import { COMMAND, CONFIG_FILE, DISPLAY_NAME, OUT_DIR, VERSION } from './brand.js';
import { loadConfig } from './config.js';
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

function printSummary(graph: Graph, outFile: string): void {
  const { stats, timings, durationMs, backendRoot, frontendRoot } = graph.meta;
  const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(22)} ${value}`);
  console.log('');
  console.log(`${DISPLAY_NAME} ${VERSION}`);
  line('backend', backendRoot ?? '(none)');
  line('frontend', frontendRoot ?? '(none)');
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
  if (graph.security) printSecurity(graph.security);
  line('graph', outFile);
  const warnings = graph.meta.warnings;
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, 15)) console.log(`  - ${w}`);
    if (warnings.length > 15) console.log(`  ... ${warnings.length - 15} more in graph.json (meta.warnings)`);
  }
}

function printSecurity(sec: NonNullable<Graph['security']>): void {
  const s = sec.summary;
  console.log('\nSecurity lens (review aid: shows where to look, certifies nothing)');
  console.log(`  authorization check seen ${s.authorization} | authenticated ${s.authenticated} | signed URL ${s.signed} | public (guest) ${s.public} | unknown ${s.unknown} | no protection found ${s.none}`);
  for (const r of sec.unknownReasons.slice(0, 5)) console.log(`  unknown: ${r.endpoints} x ${r.label}`);
  const top = sec.middleware.unresolved.filter((u) => u.decisive > 0).slice(0, 5);
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
    .option('-c, --config <file>', `config file (default: ./${CONFIG_FILE} if present)`)
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

  const { config, file: configFile } = loadConfig(opts.config, cwd);
  const warnings: string[] = [];
  if (configFile) console.log(`Using config ${configFile}`);
  const roots = resolveRoots({
    backend: opts.backend ? path.resolve(cwd, opts.backend) : config.backend,
    frontend: opts.frontend ? path.resolve(cwd, opts.frontend) : config.frontend,
    root: root ? path.resolve(cwd, root) : undefined,
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
  printSummary(graph, outFile);

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
