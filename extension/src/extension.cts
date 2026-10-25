// The editor extension: the CLI's analyzer (on the WebAssembly parser) runs in a child process, and the CLI's
// viewer shows the result in a webview. Identifiers come from package.json, which is generated from the root
// manifest (scripts/extension-manifest.mjs), so renaming the product renames them too.
import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { webviewHtml } from './webview.cjs';

/** What the worker reports when an analysis is done. */
interface Done {
  backend: string | null;
  frontend: string | null;
  config: string | null;
  configHow: string;
  ignoredSecurity: boolean;
  ms: number;
  files: number;
  security: { summary: Record<string, number>; classifyFirst: { middleware: string[]; endpoints: number } | null } | null;
}

/** The map on screen: which folder, which projects, where its graph.json is. */
interface Analysis {
  folder: string;
  backend: string | null;
  frontend: string | null;
  config: string | null;
  graphFile: string;
  madeAt: number;
}

type Message = { type: string; [key: string]: unknown };

const STAGES: Record<string, string> = {
  scan: 'finding files',
  parse: 'parsing',
  extract: 'reading definitions',
  resolve: 'resolving references',
  link: 'linking frontend calls to endpoints',
  security: 'security lens',
};

/** Files whose changes make the map out of date, and folders that never count (as in the analyzer's scan). */
const WATCHED = '**/*.{php,ts,tsx,js,jsx,mjs,cjs,mts,cts,json}';
const IGNORED = /[\\/](node_modules|vendor|\.git|\.next|\.nuxt|dist|build|storage|bootstrap[\\/]cache)[\\/]/;

export function activate(context: vscode.ExtensionContext) {
  const started = Date.now();
  const map = new MapView(context);
  context.subscriptions.push(
    map,
    vscode.commands.registerCommand(`${map.id}.open`, () => map.open()),
    vscode.commands.registerCommand(`${map.id}.refresh`, () => map.refresh()),
    vscode.commands.registerCommand(`${map.id}.revealFile`, () => map.revealActive()),
    vscode.window.registerWebviewPanelSerializer(`${map.id}.map`, { deserializeWebviewPanel: (panel) => map.restore(panel) }),
  );
  map.activationMs = Date.now() - started;
  return map.testing ? map.testApi() : undefined;
}

export function deactivate() {}

class MapView implements vscode.Disposable {
  readonly id: string;
  readonly name: string;
  readonly testing: boolean;
  activationMs = 0;
  private panel: vscode.WebviewPanel | undefined;
  private analysis: Analysis | undefined;
  private worker: ChildProcess | undefined;
  private watchers: vscode.Disposable[] = [];
  private changed = new Set<string>();
  private staleTimer: NodeJS.Timeout | undefined;
  private readonly status: vscode.StatusBarItem;
  /** The extension's log (Output panel): what was analyzed with which config, warnings, timings, viewer errors. */
  private readonly log: vscode.LogOutputChannel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly listeners = new Set<(m: Message) => void>();
  private lastRun: (Done & { wallMs: number }) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const pkg = context.extension.packageJSON as { name: string; displayName: string };
    this.id = pkg.name;
    this.name = pkg.displayName;
    this.testing = context.extensionMode === vscode.ExtensionMode.Test || process.env.CODEMAP_EXTENSION_TEST === '1';
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.log = vscode.window.createOutputChannel(this.name, { log: true });
    this.subscriptions.push(
      this.status,
      this.log,
      vscode.window.onDidChangeActiveTextEditor(() => this.postActiveFile()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (this.analysis && e.affectsConfiguration(this.id)) this.markChanged(`${this.id} settings`);
      }),
    );
  }

  dispose() {
    this.worker?.kill();
    for (const d of [...this.watchers, ...this.subscriptions]) d.dispose();
  }

  /** Analyze the workspace (or show the map already open for it). */
  async open() {
    const folder = await this.pickFolder();
    if (!folder) return;
    if (this.panel && this.analysis?.folder === folder.uri.fsPath) {
      this.panel.reveal();
      return;
    }
    await this.analyze(folder);
  }

  async refresh() {
    const folder = this.analysis ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.analysis.folder)) : await this.pickFolder();
    if (folder) await this.analyze(folder);
  }

  /** Select the active editor's file on the map. */
  async revealActive() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (!this.panel) await this.open();
    const id = this.nodeIdFor(editor.document.uri);
    this.panel?.reveal(undefined, true);
    this.post({ type: 'reveal', id, file: vscode.workspace.asRelativePath(editor.document.uri) });
  }

  private async pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      void vscode.window.showErrorMessage(`${this.name}: open a folder that contains a Laravel and/or Next.js project first.`);
      return undefined;
    }
    if (folders.length === 1) return folders[0];
    // Multi-root workspace: one map per folder (the folder plays the part of the command line's monorepo root).
    return vscode.window.showWorkspaceFolderPick({ placeHolder: `${this.name} maps one folder at a time. Which one?` });
  }

  private async analyze(folder: vscode.WorkspaceFolder) {
    this.worker?.kill();
    const settings = vscode.workspace.getConfiguration(this.id, folder.uri);
    const setting = (key: string) => {
      const value = settings.get<string>(key, '').trim();
      return value ? path.resolve(folder.uri.fsPath, value) : null;
    };
    const storage = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
    fs.mkdirSync(storage, { recursive: true });
    const graphFile = path.join(storage, `graph-${crypto.createHash('sha256').update(folder.uri.toString()).digest('hex').slice(0, 12)}.json`);
    const trusted = vscode.workspace.isTrusted;
    const request = {
      folder: folder.uri.fsPath,
      backend: setting('backend'),
      frontend: setting('frontend'),
      configFile: trusted ? setting('configFile') : null,
      security: settings.get<boolean>('security', false),
      untrusted: !trusted,
      out: graphFile,
      wasmDir: vscode.Uri.joinPath(this.context.extensionUri, 'out', 'wasm').fsPath,
    };
    const done = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${this.name}: analyzing ${folder.name}`, cancellable: true },
      (progress, token) => this.runWorker(request, progress, token),
    );
    if (!done) return;
    this.say('info', 
      `${folder.name}: ${done.files} files in ${done.ms} ms; backend ${done.backend ?? '(none)'}, frontend ${done.frontend ?? '(none)'}; config ${done.config ? `${done.config} (${done.configHow})` : 'none'}${done.ignoredSecurity ? '; its "security" section was ignored (Restricted Mode)' : ''}`,
    );
    if (done.ignoredSecurity) void vscode.window.showInformationMessage(`${this.name}: Restricted Mode, so the "security" section of the workspace's config file was ignored. Trust the workspace to apply it.`);
    this.analysis = { folder: folder.uri.fsPath, backend: done.backend, frontend: done.frontend, config: done.config, graphFile, madeAt: Date.now() };
    void this.context.workspaceState.update('analysis', this.analysis);
    this.changed.clear();
    this.watch();
    this.show();
    this.updateStatus();
  }

  private runWorker(request: object, progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken): Promise<Done | undefined> {
    return new Promise((resolve) => {
      const started = Date.now();
      const env = { ...process.env };
      if (this.testing) env.CODEMAP_EXTENSION_NO_NET = '1';
      const child = fork(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'worker.mjs').fsPath, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env });
      this.worker = child;
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += d));
      token.onCancellationRequested(() => {
        child.kill();
        resolve(undefined);
      });
      child.on('message', (m: Message) => {
        if (m.type === 'stage') progress.report({ message: STAGES[m.stage as string] ?? String(m.stage) });
        else if (m.type === 'done') {
          this.lastRun = { ...(m as unknown as Done), wallMs: Date.now() - started };
          resolve(m as unknown as Done);
        } else if (m.type === 'error') {
          this.say('error', String(m.message));
          void vscode.window.showErrorMessage(`${this.name}: ${m.message}`);
          resolve(undefined);
        }
      });
      child.on('exit', (code) => {
        if (this.worker === child) this.worker = undefined;
        if (code && !token.isCancellationRequested) {
          void vscode.window.showErrorMessage(`${this.name}: the analysis stopped unexpectedly (exit code ${code}). ${stderr.trim().split('\n').slice(-3).join(' ')}`);
        }
        resolve(undefined);
      });
      child.send(request);
    });
  }

  /** Show (or reload) the webview with the current graph.json. */
  private show() {
    const a = this.analysis!;
    const viewerDir = vscode.Uri.joinPath(this.context.extensionUri, 'out', 'viewer');
    const options = { enableScripts: true, localResourceRoots: [viewerDir, vscode.Uri.file(path.dirname(a.graphFile))] };
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(`${this.id}.map`, this.name, vscode.ViewColumn.Active, { ...options, retainContextWhenHidden: true });
      this.wire(this.panel);
    } else this.panel.webview.options = options;
    this.panel.title = `${this.name}: ${path.basename(a.folder)}`;
    this.panel.webview.html = webviewHtml(this.panel.webview, viewerDir, this.name, {
      graphUrl: `${this.panel.webview.asWebviewUri(vscode.Uri.file(a.graphFile)).toString()}?made=${a.madeAt}`,
      store: this.storeSnapshot(),
      test: this.testing,
    });
    void vscode.commands.executeCommand('setContext', `${this.id}.mapOpen`, true);
  }

  /** After a window reload: show the last map again, without re-analyzing. */
  async restore(panel: vscode.WebviewPanel) {
    const saved = this.context.workspaceState.get<Analysis>('analysis');
    this.panel = panel;
    this.wire(panel);
    if (!saved || !fs.existsSync(saved.graphFile)) {
      panel.webview.html = `<p style="font-family: sans-serif; padding: 1em">Run "${this.name}: Open Map" to analyze the workspace.</p>`;
      return;
    }
    this.analysis = saved;
    this.watch();
    this.show();
    this.updateStatus();
  }

  private wire(panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      void vscode.commands.executeCommand('setContext', `${this.id}.mapOpen`, false);
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
  }

  private onMessage(m: Message) {
    if (m.type === 'ready') {
      this.postActiveFile();
      if (this.changed.size) this.post({ type: 'stale', files: this.changed.size });
    } else if (m.type === 'open') void this.openFile(String(m.file), Number(m.line));
    else if (m.type === 'store') void this.context.globalState.update(`viewer:${String(m.key)}`, m.value);
    else if (m.type === 'refresh') void this.refresh();
    else if (m.type === 'log') this.say('error', `viewer: ${String(m.message)}`);
    else if (m.type === 'schemaProblem' || m.type === 'loadError') this.say('warn', `viewer: ${String(m.message)}`);
    for (const listener of this.listeners) listener(m);
  }

  /** Log to the Output panel (and the console in test runs, so CI shows it). */
  private say(level: 'info' | 'warn' | 'error', message: string) {
    this.log[level](message);
    if (!this.testing) return;
    console.log(`[${this.name} ${level}] ${message}`);
    if (process.env.CODEMAP_TEST_LOG) fs.appendFileSync(process.env.CODEMAP_TEST_LOG, `    [extension ${level}] ${message}\n`);
  }

  private post(message: Message) {
    void this.panel?.webview.postMessage(message);
  }

  /** Viewer preferences and first-run state, kept by the extension so they outlive the panel. */
  private storeSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of this.context.globalState.keys()) if (key.startsWith('viewer:')) out[key.slice(7)] = String(this.context.globalState.get(key));
    return out;
  }

  /** Open a file of the analyzed projects at a line, beside the map. */
  private async openFile(file: string, line: number) {
    const abs = path.resolve(file);
    const a = this.analysis;
    const inside = [a?.backend, a?.frontend].some((root) => root && !path.relative(root, abs).startsWith('..') && !path.isAbsolute(path.relative(root, abs)));
    if (!inside) return;
    const position = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(vscode.Uri.file(abs), { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(position, position) });
  }

  /** The map's node id of a file: be:/fe: and its path relative to its project root (the analyzer's ids). */
  private nodeIdFor(uri: vscode.Uri): string | null {
    const a = this.analysis;
    if (!a || uri.scheme !== 'file') return null;
    for (const [root, prefix] of [[a.backend, 'be:'], [a.frontend, 'fe:']] as const) {
      if (!root) continue;
      const rel = path.relative(root, uri.fsPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return prefix + rel.split(path.sep).join('/');
    }
    return null;
  }

  private postActiveFile() {
    const editor = vscode.window.activeTextEditor;
    this.post({ type: 'activeFile', id: editor ? this.nodeIdFor(editor.document.uri) : null });
  }

  /** Watch the analyzed projects: a change after the analysis makes the map out of date. */
  private watch() {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    const a = this.analysis!;
    for (const root of [a.backend, a.frontend]) {
      if (!root) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), WATCHED));
      const on = (uri: vscode.Uri) => {
        if (!IGNORED.test(uri.fsPath)) this.markChanged(uri.fsPath);
      };
      this.watchers.push(watcher, watcher.onDidChange(on), watcher.onDidCreate(on), watcher.onDidDelete(on));
    }
  }

  private markChanged(what: string) {
    this.changed.add(what);
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.post({ type: 'stale', files: this.changed.size });
      this.updateStatus();
    }, 400);
  }

  private updateStatus() {
    if (!this.analysis) return this.status.hide();
    const stale = this.changed.size > 0;
    this.status.text = stale ? `$(sync) ${this.name}: out of date` : `$(type-hierarchy) ${this.name}`;
    this.status.tooltip = stale
      ? `${this.changed.size} change(s) since the map was made at ${new Date(this.analysis.madeAt).toLocaleTimeString()}. Click to refresh.`
      : `Map of ${path.basename(this.analysis.folder)}, made at ${new Date(this.analysis.madeAt).toLocaleTimeString()}.`;
    this.status.command = stale ? `${this.id}.refresh` : `${this.id}.open`;
    this.status.show();
  }

  /** For the extension's integration tests (test runs only). */
  testApi() {
    let seq = 0;
    const next = (type: string, timeoutMs = 60_000) =>
      new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.listeners.delete(listener);
          reject(new Error(`no "${type}" message from the webview within ${timeoutMs} ms`));
        }, timeoutMs);
        const listener = (m: Message) => {
          if (m.type !== type) return;
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve(m);
        };
        this.listeners.add(listener);
      });
    return {
      activationMs: this.activationMs,
      next,
      query: async (action: string, extra: object = {}) => {
        const id = ++seq;
        const result = new Promise<Message>((resolve) => {
          const listener = (m: Message) => {
            if (m.type === 'testResult' && m.seq === id) {
              this.listeners.delete(listener);
              resolve(m);
            }
          };
          this.listeners.add(listener);
        });
        this.post({ type: 'test', action, seq: id, ...extra });
        return result;
      },
      /** Show a given graph.json (the schema check test). */
      showGraph: (file: string) => {
        this.analysis = { ...this.analysis!, graphFile: file, madeAt: Date.now() };
        this.show();
      },
      analysis: () => this.analysis,
      lastRun: () => this.lastRun,
      status: () => ({ text: this.status.text, changed: this.changed.size }),
    };
  }
}
