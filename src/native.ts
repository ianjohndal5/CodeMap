import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** dist/native: the prebuilt Tree-sitter binaries the build copies in (scripts/vendor-native.mjs). */
const VENDORED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native');

/**
 * A native Tree-sitter package: the copy in dist/native when present (the published package), else the
 * development install in node_modules. The published package has no native dependencies, so installing it
 * compiles nothing and leaves no peer ranges to resolve.
 */
export function loadNative<T>(pkg: string): T {
  const vendored = path.join(VENDORED, pkg);
  try {
    return require(fs.existsSync(vendored) ? vendored : pkg) as T;
  } catch (e) {
    const msg = (e as Error).message;
    if (/No native build was found/.test(msg)) {
      throw new Error(
        `No prebuilt Tree-sitter parser for ${process.platform}-${process.arch}. Prebuilt: Linux, macOS and Windows on x64 and arm64 (on Linux: glibc, and musl on x64 only). (${pkg}: ${msg.split('\n')[0]})`,
      );
    }
    throw e;
  }
}
