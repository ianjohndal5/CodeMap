import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DISPLAY_NAME } from './brand.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
/** viewer/ sits next to src/ and dist/ in the package. */
export const VIEWER_DIR = path.resolve(here, '..', 'viewer');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** Vendor scripts and fonts are served from node_modules so the viewer works offline. */
function vendorFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'cytoscape.min.js': require.resolve('cytoscape/dist/cytoscape.min.js'),
    'elk.bundled.js': require.resolve('elkjs/lib/elk.bundled.js'),
    'cytoscape-elk.js': require.resolve('cytoscape-elk/dist/cytoscape-elk.js'),
  };
  // /vendor/fonts/<file>.woff2 from the @fontsource packages (latin subset only).
  for (const pkg of ['ibm-plex-sans', 'ibm-plex-mono', 'space-grotesk']) {
    const dir = path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), 'files');
    for (const f of fs.readdirSync(dir)) {
      if (/-latin-\d+-normal\.woff2$/.test(f)) files[`fonts/${f}`] = path.join(dir, f);
    }
  }
  return files;
}

export interface ServeOptions {
  graphFile: string;
  port: number;
  host?: string;
}

/** Serve the static viewer and graph.json on localhost. Tries the next ports if the requested one is busy. */
export function serve(opts: ServeOptions): Promise<{ url: string; server: http.Server }> {
  const vendor = vendorFiles();
  const host = opts.host ?? '127.0.0.1';
  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file: string | null = null;
    if (url.pathname === '/' || url.pathname === '/index.html') file = path.join(VIEWER_DIR, 'index.html');
    else if (url.pathname === '/graph.json') file = opts.graphFile;
    // The format check the viewer runs before rendering, compiled from src/schema.ts next to this file.
    else if (url.pathname === '/schema.js') file = path.join(here, 'schema.js');
    else if (url.pathname.startsWith('/vendor/')) file = vendor[url.pathname.slice('/vendor/'.length)] ?? null;
    else {
      const candidate = path.join(VIEWER_DIR, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
      if (candidate.startsWith(VIEWER_DIR + path.sep)) file = candidate;
    }
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const immutable = url.pathname.startsWith('/vendor/');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'max-age=86400' : 'no-store',
    });
    // The page title and header carry the product name from package.json (see brand.ts).
    if (path.basename(file) === 'index.html') res.end(fs.readFileSync(file, 'utf8').replaceAll('SeamMap', DISPLAY_NAME));
    else fs.createReadStream(file).pipe(res);
  };

  return new Promise((resolve, reject) => {
    const tryPort = (port: number, attemptsLeft: number) => {
      const server = http.createServer(handler);
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) tryPort(port + 1, attemptsLeft - 1);
        else reject(err);
      });
      server.listen(port, host, () => resolve({ url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${port}/`, server }));
    };
    tryPort(opts.port, 10);
  });
}
