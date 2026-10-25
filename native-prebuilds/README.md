# Rebuilt native binaries

Some upstream Tree-sitter prebuilds fail on supported platforms, so the published package ships these instead.
`scripts/vendor-native.mjs` copies them over upstream's when it puts the binaries into `dist/native`, and
`npm pack` refuses to run while one is missing.

| Files | Why upstream's are replaced |
| --- | --- |
| `tree-sitter/<platform>/tree-sitter.node`, all six platforms | `tree-sitter` 0.25.1's are built for Node-API 10: they crash on load (segfault) in Node 20 and in Node 22 before 22.14. These are built for Node-API 8. Upstream's Linux ones also need GCC 13's libstdc++, which Debian 12 and Ubuntu 22.04 lack; these link it statically and need glibc 2.17 or newer. |
| `tree-sitter/linux-x64/tree-sitter.musl.node` | Upstream has no musl build. node-gyp-build loads this one on Alpine and the glibc one elsewhere. |
| `tree-sitter-typescript/linux-arm64/tree-sitter-typescript.node` | `tree-sitter-typescript` 0.23.2's `linux-arm64` prebuild is an x86-64 binary. |

The other grammar prebuilds (`tree-sitter-php`, `tree-sitter-javascript`, `tree-sitter-typescript` on the
other platforms) are Node-API 8 builds of the right architecture and are used as published.

`<package>/VERSION` is the version a directory was built from: the vendoring step ignores a directory built
from another version than the installed one, and `npm pack` refuses. `SHA256SUMS` lists the checksums of the
committed files; the workflow that built them prints the same list. Rebuilds are not guaranteed to be
byte-identical.

## Rebuilding

After upgrading `tree-sitter` or `tree-sitter-typescript`, run the **native-prebuilds** workflow
(`.github/workflows/native-prebuilds.yml`; Actions → native-prebuilds → Run workflow). It builds each binary
on the platform it is for (Linux in Docker, with `scripts/build-linux-binding.sh`), runs the tests with each on
Node 20, and uploads one artifact, `native-prebuilds`. Download it, then from the repository root:

```bash
unzip -o native-prebuilds.zip -d native-prebuilds
npm run build && npm test
git add native-prebuilds
```

`scripts/build-linux-binding.sh` builds the Linux binaries locally too (Docker required).

Alpine on arm64 has no musl build of the core binding, so it is not supported.
