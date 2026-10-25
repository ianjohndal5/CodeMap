// The analysis, in a child process forked by the extension: the CLI's analyzer on the WebAssembly parser. One
// analysis per process, so the editor never waits on it and the parser's memory goes away with the process.
// The request comes in the environment (CODEMAP_WORKER_REQUEST, JSON), not as an IPC message: this module loads
// asynchronously, and Node drops IPC messages that arrive before a 'message' listener exists. Messages only go
// out: stages, then one 'done' or 'error'.
import fs from 'node:fs';
import path from 'node:path';

/** For the extension's tests: any network use during the analysis fails loudly. */
async function blockNetwork() {
  // The CommonJS exports objects: an ES module namespace is read-only.
  const net = (await import('node:net')).default;
  const dns = (await import('node:dns')).default;
  const fail = () => {
    throw new Error('network access attempted during the analysis');
  };
  net.Socket.prototype.connect = fail;
  dns.lookup = fail;
  dns.promises.lookup = fail;
}

// Keep the event loop turning until the last message is written: on Node 20.9 (VS Code 1.90) an idle loop can
// stall (see wasmRuntime in analyzer/wasm-runtime.js), here also after the analysis.
const awake = setInterval(() => {}, 25);

/** Send the last message, and leave only once it is written: exiting earlier can lose it. */
function finish(message) {
  process.send(message, () => {
    clearInterval(awake);
    process.disconnect();
  });
}

async function main(req) {
  try {
    if (process.env.CODEMAP_EXTENSION_NO_NET === '1') await blockNetwork();
    const wts = await import('web-tree-sitter');
    const { setParserRuntime } = await import('./analyzer/parse.js');
    const { wasmRuntime, inFolder } = await import('./analyzer/wasm-runtime.js');
    setParserRuntime(await wasmRuntime(wts, inFolder(req.wasmDir)));
    const { analyze } = await import('./analyzer/analyze.js');
    const { defaultConfig, findConfig, loadConfig } = await import('./analyzer/config.js');
    const { resolveRoots } = await import('./analyzer/detect.js');

    // The command line's rules (README: Configuration): the settings act like --backend, --frontend and --config,
    // and the workspace folder like the monorepo root of `codemap <folder>`.
    const starts = [];
    if (req.backend) starts.push({ dir: req.backend, label: 'backend root', role: 'backend' });
    if (req.frontend) starts.push({ dir: req.frontend, label: 'frontend root', role: 'frontend' });
    starts.push({ dir: req.folder, label: 'workspace folder' });
    const lookup = req.configFile ? { file: req.configFile, how: 'set in the configFile setting', searched: [], others: [] } : findConfig(starts);
    const { config } = lookup.file ? loadConfig(lookup.file, req.folder) : { config: defaultConfig() };
    const warnings = lookup.others.map((f) => `Also found ${f}, not used (${lookup.file} was chosen: ${lookup.how}).`);
    // Restricted Mode: an untrusted config must not be able to make routes look protected.
    let ignoredSecurity = false;
    if (req.untrusted && lookup.file) {
      config.security = defaultConfig().security;
      ignoredSecurity = true;
      warnings.push(`Restricted Mode: the "security" section of ${path.basename(lookup.file)} was ignored (classifications and SARIF imports). Trust the workspace to apply it.`);
    }
    const roots = resolveRoots({ backend: req.backend ?? config.backend, frontend: req.frontend ?? config.frontend, root: req.folder });
    warnings.push(...roots.warnings);

    const started = performance.now();
    const { graph } = analyze({
      backend: roots.backend,
      frontend: roots.frontend,
      config,
      warnings,
      security: req.security,
      onStage: (stage) => process.send({ type: 'stage', stage }),
    });
    fs.writeFileSync(req.out, JSON.stringify(graph));
    finish({
      type: 'done',
      backend: roots.backend,
      frontend: roots.frontend,
      config: lookup.file,
      configHow: lookup.how,
      ignoredSecurity,
      ms: Math.round(performance.now() - started),
      files: graph.meta.stats.files,
      security: graph.security ? { summary: graph.security.summary, classifyFirst: graph.security.classifyFirst } : null,
    });
  } catch (e) {
    finish({ type: 'error', message: e?.message ?? String(e) });
  }
}

void main(JSON.parse(process.env.CODEMAP_WORKER_REQUEST ?? '{}'));
