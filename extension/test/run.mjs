// The extension's integration tests, in a real VS Code: @vscode/test-electron downloads one (CODE_VERSION, default
// stable), or CODE_EXECUTABLE names a local one. The workspace is a temporary copy of two of the repository's
// fixture projects, so the tests can change settings and files. Build first: npm run build (in extension/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.resolve(ext, '..', 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seammap-ext-test-'));
const workspace = path.join(tmp, 'workspace');
fs.cpSync(path.join(fixtures, 'laravel-api'), path.join(workspace, 'api'), { recursive: true });
fs.cpSync(path.join(fixtures, 'next-web'), path.join(workspace, 'web'), { recursive: true });
console.log(`test folder: ${tmp}`);

try {
  await runTests({
    ...(process.env.CODE_EXECUTABLE ? { vscodeExecutablePath: process.env.CODE_EXECUTABLE } : { version: process.env.CODE_VERSION ?? 'stable' }),
    extensionDevelopmentPath: ext,
    extensionTestsPath: path.join(ext, 'test', 'suite.cjs'),
    launchArgs: [
      // CODEMAP_PERF_WORKSPACE: time a large real project instead (suite.cjs then runs only the timing test).
      process.env.CODEMAP_PERF_WORKSPACE ?? workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-gpu',
      // CI runners can't set up Chromium's Linux sandbox helper; the tests run trusted code only.
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      // CODE_HEADLESS=1 (Linux): no window at all, without Xvfb.
      ...(process.env.CODE_HEADLESS ? ['--ozone-platform=headless'] : []),
      `--user-data-dir=${path.join(tmp, 'user-data')}`,
      `--extensions-dir=${path.join(tmp, 'extensions')}`,
    ],
    extensionTestsEnv: { CODEMAP_TEST_WORKSPACE: workspace, CODEMAP_TEST_LOG: path.join(tmp, 'tests.log'), ...(process.env.CODEMAP_PERF_WORKSPACE ? { CODEMAP_PERF_WORKSPACE: process.env.CODEMAP_PERF_WORKSPACE } : {}) },
  });
} catch (e) {
  console.error(`extension tests failed: ${e.message ?? e}`);
  process.exitCode = 1;
} finally {
  const log = path.join(tmp, 'tests.log');
  console.log(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'the test suite wrote nothing (it did not start)');
  fs.rmSync(tmp, { recursive: true, force: true });
}
