/* global acquireVsCodeApi */
// Where the viewer runs: a browser tab served by the CLI (the default), or a VS Code webview, which the extension
// sets up by defining window.CODEMAP_WEBVIEW before the scripts load. Everything that differs goes through here.

const config = typeof acquireVsCodeApi === 'function' ? window.CODEMAP_WEBVIEW : null;
const vscode = config ? acquireVsCodeApi() : null;

/** True inside the editor extension's webview. */
export const inWebview = Boolean(vscode);

/** graph.json: next to the page (the CLI's server) or where the extension wrote it. */
export const graphUrl = config?.graphUrl ?? 'graph.json';

/** Send a message to the extension (no-op in a browser). */
export function postToHost(message) {
  vscode?.postMessage(message);
}

/** Messages from the extension: refresh notices, files to reveal, the active editor. */
export function onHostMessage(handler) {
  if (vscode) window.addEventListener('message', (e) => handler(e.data));
}

/**
 * Preferences and first-run state. In a browser: localStorage. In VS Code: the extension's global storage (a
 * snapshot comes with the page, changes go back as messages), so they outlive the panel and the session.
 */
export const store = vscode
  ? {
      get: (k) => config.store?.[k] ?? null,
      set: (k, v) => {
        (config.store ??= {})[k] = v;
        vscode.postMessage({ type: 'store', key: k, value: v });
      },
    }
  : {
      get(k) {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      set(k, v) {
        try {
          localStorage.setItem(k, v);
        } catch {
          // Storage unavailable (private mode): preferences are simply not remembered.
        }
      },
    };

/**
 * Open a vscode://file/<path>:<line> link. A browser hands it to the OS (the installed VS Code opens it); the
 * webview asks the extension, which opens the file beside the map (also over remote SSH, WSL, containers).
 */
export function openLink(url) {
  if (!vscode) {
    const a = document.createElement('a');
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const m = /^vscode:\/\/file(\/.*):(\d+)$/.exec(url);
  if (!m) return;
  let file = decodeURIComponent(m[1]);
  if (/^\/[A-Za-z]:\//.test(file)) file = file.slice(1); // "/C:/x" -> "C:/x"
  vscode.postMessage({ type: 'open', file, line: Number(m[2]) });
}

// In the webview, script errors go to the extension's log (there is no browser console to look at).
if (vscode) {
  const report = (message) => vscode.postMessage({ type: 'log', level: 'error', message: String(message) });
  window.addEventListener('error', (e) => report(`${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => report(e.reason?.stack ?? e.reason));
  document.addEventListener('securitypolicyviolation', (e) => report(`blocked by the content security policy: ${e.violatedDirective} ${e.blockedURI}`));
}

// In the webview, every "open" link in the panel goes through openLink.
if (vscode) {
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target.closest?.('a[href^="vscode://file"]');
      if (!a) return;
      e.preventDefault();
      openLink(a.getAttribute('href'));
    },
    true,
  );
}

/** The editor's theme in VS Code ('light' or 'dark', from the classes VS Code puts on <body>); null in a browser. */
export function editorTheme() {
  if (!vscode) return null;
  const c = document.body.classList;
  return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark';
}

/** Call `cb` with the new theme whenever the editor's theme changes (VS Code only). */
export function onEditorTheme(cb) {
  if (!vscode) return;
  let last = editorTheme();
  new MutationObserver(() => {
    const now = editorTheme();
    if (now !== last) cb((last = now));
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/** Test hooks for the extension's integration tests (only when the extension runs its test suite). */
export const testMode = Boolean(config?.test);
