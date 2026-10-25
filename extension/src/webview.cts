import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

/** What the page reads from window.CODEMAP_WEBVIEW (viewer/host.js). */
export interface ViewerConfig {
  graphUrl: string;
  store: Record<string, string>;
  test: boolean;
}

/**
 * The CLI's viewer page, as a webview: its relative assets resolve against the extension's copy of the viewer
 * (a <base>), the content security policy allows scripts, styles and fonts from the extension only and no
 * network at all, and the page gets the settings the CLI's server would give it (display name, graph location).
 */
export function webviewHtml(webview: vscode.Webview, viewerDir: vscode.Uri, displayName: string, config: ViewerConfig): string {
  const nonce = crypto.randomBytes(18).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `connect-src ${webview.cspSource}`,
  ].join('; ');
  const settings = JSON.stringify(config).replace(/</g, '\\u003c');
  return fs
    .readFileSync(path.join(viewerDir.fsPath, 'index.html'), 'utf8')
    .replaceAll('CodeMap', displayName)
    .replaceAll('<script ', `<script nonce="${nonce}" `)
    .replace(
      '<head>',
      `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">\n  <base href="${webview.asWebviewUri(viewerDir).toString()}/">\n  <script nonce="${nonce}">window.CODEMAP_WEBVIEW = ${settings};</script>`,
    );
}
