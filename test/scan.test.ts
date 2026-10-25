import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { scanLaravel, scanNext } from '../src/scan.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seammap-scan-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

describe('file discovery', () => {
  it('scans Next.js sources honouring nested .gitignore files and built-in skips', () => {
    const root = path.join(tmp, 'web');
    write(root, {
      '.gitignore': 'generated/\n*.secret.ts\n',
      'src/app/page.tsx': '',
      'src/lib/api.ts': '',
      'src/lib/keys.secret.ts': '',
      'generated/client.ts': '',
      'src/legacy/.gitignore': 'old.js\n',
      'src/legacy/old.js': '',
      'src/legacy/new.js': '',
      'node_modules/react/index.js': '',
      '.next/server/page.js': '',
      'dist/bundle.js': '',
      'public/vendor.min.js': '',
      'next-env.d.ts': '',
      'next.config.mjs': '',
    });
    expect(scanNext(root, defaultConfig())).toEqual(['next.config.mjs', 'src/app/page.tsx', 'src/legacy/new.js', 'src/lib/api.ts']);
    const config = defaultConfig();
    config.next.exclude.push('src/legacy/**');
    expect(scanNext(root, config)).toEqual(['next.config.mjs', 'src/app/page.tsx', 'src/lib/api.ts']);
  });

  it('scans Laravel PSR-4 roots and routes, skipping framework directories', () => {
    const root = path.join(tmp, 'api');
    write(root, {
      'app/Models/User.php': '',
      'src/Domain/Thing.php': '',
      'routes/api.php': '',
      'routes/console.php': '',
      'routes/channels.php': '',
      'vendor/laravel/x.php': '',
      'database/seeders/S.php': '',
      'tests/T.php': '',
      'config/app.php': '',
      'resources/views/welcome.blade.php': '',
      'storage/x.php': '',
    });
    const psr4 = [
      { prefix: 'Domain\\', dirs: ['src/Domain'] },
      { prefix: 'App\\', dirs: ['app'] },
      { prefix: 'Database\\Seeders\\', dirs: ['database/seeders'] },
    ];
    expect(scanLaravel(root, { psr4, files: [] }, defaultConfig())).toEqual(['app/Models/User.php', 'routes/api.php', 'src/Domain/Thing.php']);
  });
});
