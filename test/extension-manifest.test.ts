import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extensionLock, extensionManifest } from '../scripts/extension-manifest.mjs';

const root = path.resolve(__dirname, '..');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

describe('extension/package.json', () => {
  it('is generated from package.json (node scripts/extension-manifest.mjs)', () => {
    const current = read('extension/package.json');
    expect(current).toEqual(extensionManifest(read('package.json'), current));
    const lock = read('extension/package-lock.json');
    expect(lock).toEqual(extensionLock(lock, current));
  });

  it("derives every identifier from the CLI's command name", () => {
    const pkg = read('package.json');
    const command = Object.keys(pkg.bin)[0];
    const m = read('extension/package.json');
    expect(m.name).toBe(command);
    expect(m.version).toBe(pkg.version);
    expect(m.displayName).toBe(pkg.displayName);
    for (const c of m.contributes.commands) expect(c.command.startsWith(`${command}.`)).toBe(true);
    for (const key of Object.keys(m.contributes.configuration.properties)) expect(key.startsWith(`${command}.`)).toBe(true);
    expect(m.activationEvents).toEqual([`onWebviewPanel:${command}.map`]);
  });
});
