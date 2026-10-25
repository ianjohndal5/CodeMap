// Runs inside VS Code's extension host (see run.mjs). The extension exposes a test API in test runs: it waits for
// the webview's messages and drives the viewer through its test hooks (viewer/host.js, App.onTest).
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const extDir = path.resolve(__dirname, '..');
const workspace = process.env.CODEMAP_TEST_WORKSPACE;
/** Progress, written as it happens (run.mjs prints it: the extension host's console is not always forwarded). */
const trace = (line) => {
  if (process.env.CODEMAP_TEST_LOG) fs.appendFileSync(process.env.CODEMAP_TEST_LOG, line + '\n');
  console.log(line);
};
const TEST_TIMEOUT = 240_000;
const until = async (what, check, timeoutMs = 20_000) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

exports.run = async () => {
  trace('suite started');
  // path.relative compares like the OS does (Windows: case-insensitive drive letters).
  const ext = vscode.extensions.all.find((e) => path.relative(e.extensionPath, extDir) === '');
  assert.ok(ext, 'the extension under test is loaded');
  const id = ext.packageJSON.name;
  const api = await ext.activate();
  trace(`activated ${ext.id} (test API: ${Boolean(api)})`);
  const results = [];
  let failed = 0;
  const test = async (name, fn) => {
    const started = Date.now();
    trace(`- ${name}`);
    let timer;
    try {
      await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${TEST_TIMEOUT} ms`)), TEST_TIMEOUT)))]);
      results.push(`  ok    ${name} (${Date.now() - started} ms)`);
    } catch (e) {
      failed++;
      results.push(`  FAIL  ${name}\n${String(e.stack ?? e).replace(/^/gm, '        ')}`);
    } finally {
      clearTimeout(timer);
    }
    trace(results.at(-1));
  };
  const graph = () => JSON.parse(fs.readFileSync(api.analysis().graphFile, 'utf8'));

  const perf = Boolean(process.env.CODEMAP_PERF_WORKSPACE);
  if (!perf) await suite();
  async function suite() {
  await test('activates quickly', () => {
    assert.ok(api.activationMs < 1000, `activation took ${api.activationMs} ms`);
  });

  await test('opens the map of the workspace in a webview', async () => {
    const ready = api.next('ready', 120_000);
    await vscode.commands.executeCommand(`${id}.open`);
    const m = await ready;
    assert.ok(m.cards > 10, `${m.cards} cards rendered`);
    assert.equal(path.basename(api.analysis().backend), 'api');
    assert.equal(path.basename(api.analysis().frontend), 'web');
    const g = graph();
    assert.equal(g.schemaVersion, 1);
    assert.ok(g.edges.some((e) => e.kind === 'http'), 'frontend calls are linked to endpoints');
  });

  let method;
  await test('opens a file at the right line beside the map', async () => {
    method = graph().nodes.find((n) => n.kind === 'method' && n.side === 'backend' && n.line > 1);
    const opened = new Promise((resolve) => {
      const sub = vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) {
          sub.dispose();
          resolve(e);
        }
      });
    });
    await api.query('open', { id: method.id });
    const editor = await opened;
    assert.ok(editor.document.uri.fsPath.endsWith(path.join(...method.file.split('/'))), editor.document.uri.fsPath);
    // The editor becomes active before the requested selection is applied.
    await until(`the cursor on line ${method.line}`, () => vscode.window.activeTextEditor?.selection.active.line === method.line - 1, 5000);
    assert.equal(editor.viewColumn, vscode.ViewColumn.Two, 'beside the map');
  });

  await test("highlights the active editor's file on the map", async () => {
    const file = `be:${method.file}`;
    await until('the active-file mark', async () => (await api.query('state')).activeFile.includes(file));
  });

  await test('shows the current file on the map', async () => {
    await vscode.commands.executeCommand(`${id}.revealFile`);
    await until('the revealed file to be selected', async () => (await api.query('state')).selected === `be:${method.file}`);
  });

  await test('adds the security lens when the setting is on', async () => {
    await vscode.workspace.getConfiguration(id).update('security', true, vscode.ConfigurationTarget.Workspace);
    const ready = api.next('ready', 120_000);
    await vscode.commands.executeCommand(`${id}.refresh`);
    await ready;
    assert.ok(graph().security, 'graph.json has the security report');
    assert.ok(api.lastRun().security.summary, 'the worker reported the summary');
    const state = await api.query('lens', { on: true });
    assert.equal(state.securityTab, true);
    assert.equal(state.secLens, true);
  });

  await test('marks the map out of date when a file changes, and refresh brings it up to date', async () => {
    const file = path.join(workspace, 'web', 'src', 'lib', 'users.ts');
    fs.appendFileSync(file, '\nexport const touched = 1;\n');
    await until('the out-of-date status', () => /out of date/.test(api.status().text));
    await until('the out-of-date notice in the map', async () => (await api.query('state')).toasts.some((t) => /changed/.test(t)));
    const ready = api.next('ready', 120_000);
    await vscode.commands.executeCommand(`${id}.refresh`);
    await ready;
    assert.equal(api.status().changed, 0);
    assert.doesNotMatch(api.status().text, /out of date/);
  });

  await test("follows the editor's light or dark theme", async () => {
    const colors = vscode.workspace.getConfiguration('workbench');
    await colors.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
    await until('the light theme in the map', async () => (await api.query('state')).theme === 'light');
    await colors.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
    await until('the dark theme in the map', async () => (await api.query('state')).theme === 'dark');
  });

  await test('explains a graph.json from a newer format version instead of drawing it', async () => {
    const newer = path.join(path.dirname(api.analysis().graphFile), 'newer-format.json');
    fs.writeFileSync(newer, JSON.stringify({ ...graph(), schemaVersion: 999, meta: { ...graph().meta, version: '9.0.0' } }));
    const problem = api.next('schemaProblem');
    api.showGraph(newer);
    const m = await problem;
    assert.equal(m.kind, 'newer');
    assert.match(m.message, /format version 999, written by CodeMap 9\.0\.0/);
  });

  await test("ignores the config's security section in Restricted Mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-untrusted-'));
    fs.cpSync(path.join(workspace, 'api'), path.join(dir, 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.config.json`), JSON.stringify({ backend: 'api', security: { authMiddleware: ['api'] } }));
    const runWorker = (untrusted) =>
      new Promise((resolve, reject) => {
        const request = { folder: dir, backend: null, frontend: null, configFile: null, security: true, untrusted, out: path.join(dir, `graph-${untrusted}.json`), wasmDir: path.join(extDir, 'out', 'wasm') };
        const child = fork(path.join(extDir, 'out', 'worker.mjs'), [], { env: { ...process.env, CODEMAP_EXTENSION_NO_NET: '1', CODEMAP_WORKER_REQUEST: JSON.stringify(request) } });
        child.on('message', (m) => (m.type === 'done' ? resolve(m) : m.type === 'error' ? reject(new Error(m.message)) : null));
      });
    const trusted = await runWorker(false);
    const restricted = await runWorker(true);
    assert.equal(trusted.ignoredSecurity, false);
    assert.equal(restricted.ignoredSecurity, true);
    // "api" as authMiddleware makes every API route authenticated, unless it is ignored.
    assert.ok(trusted.security.summary.authenticated > restricted.security.summary.authenticated, JSON.stringify([trusted.security.summary, restricted.security.summary]));
    const warnings = JSON.parse(fs.readFileSync(path.join(dir, 'graph-true.json'), 'utf8')).meta.warnings;
    assert.ok(warnings.some((w) => /Restricted Mode/.test(w)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('makes no network requests', () => {
    // Every analysis above ran with networking blocked in the worker (CODEMAP_EXTENSION_NO_NET), and the webview's
    // content security policy allows no remote origin. The shipped code imports no networking module either.
    const files = fs.readdirSync(path.join(extDir, 'out'), { recursive: true }).map(String).filter((f) => /\.(c|m)?js$/.test(f) && !f.startsWith(`viewer${path.sep}vendor`));
    const net = /\b(?:require\(|from\s+|import\()\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/;
    const offenders = files.filter((f) => f !== 'worker.mjs' && net.test(fs.readFileSync(path.join(extDir, 'out', f), 'utf8')));
    assert.deepEqual(offenders, []);
    assert.ok(api.lastRun(), 'analyses ran with the network blocked');
  });

  }

  if (perf) {
    // Not part of CI: a large real project (CODEMAP_PERF_WORKSPACE names its folder) for timings.
    await test('performance on a large project', async () => {
      const folder = vscode.workspace.workspaceFolders[0];
      const run = async (label) => {
        const started = Date.now();
        const ready = api.next('ready', 600_000);
        const painted = api.next('painted', 600_000);
        await vscode.commands.executeCommand(`${id}.${label === 'first' ? 'open' : 'refresh'}`);
        const analysed = Date.now();
        const m = await ready;
        const shown = Date.now();
        const firstFrame = (await painted).ms;
        const trips = [];
        for (let i = 0; i < 5; i++) {
          const t0 = Date.now();
          await api.query('state');
          trips.push(Date.now() - t0);
        }
        const r = api.lastRun();
        results.push(`        ${label}: ${folder.name}, ${r.files} files${r.security ? ', with the security lens' : ''}: analysis ${r.ms} ms in the worker (${r.wallMs} ms with its startup), webview ready ${shown - analysed} ms later (${m.cards} cards), its first frame drawn ${firstFrame} ms after that, command to ready ${shown - started} ms; viewer message round trips ${trips.join('/')} ms`);
      };
      await run('first');
      await vscode.workspace.getConfiguration(id).update('security', true, vscode.ConfigurationTarget.Global);
      await run('security');
      results.push(`        activation ${api.activationMs} ms`);
    });
  }

  trace(`\n${ext.packageJSON.displayName} extension tests\n${results.join('\n')}\n${failed ? `${failed} failed` : 'all passed'}\n`);
  if (failed) throw new Error(`${failed} extension test(s) failed`);
};
