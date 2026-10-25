// Release safeguard: CHANGELOG.md must have a section for the version being released.
// `npm version` runs it as preversion (before anything is bumped, with the new version in npm_new_version),
// and `npm publish` as prepublishOnly (the version in package.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The versions with a `## [x.y.z]` section in a Keep a Changelog file ("Unreleased" is not one). */
export function changelogVersions(text) {
  return [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const version = process.env.npm_new_version || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!changelogVersions(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')).includes(version)) {
    console.error(`CHANGELOG.md has no "## [${version}]" section. Move the Unreleased entries under "## [${version}] - YYYY-MM-DD", commit, then release.`);
    process.exit(1);
  }
}
