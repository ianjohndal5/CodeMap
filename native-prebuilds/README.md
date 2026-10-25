# Rebuilt native binaries

`tree-sitter/linux-x64` and `tree-sitter/linux-arm64` hold the Tree-sitter core binding (the `tree-sitter`
npm package, version in `tree-sitter/VERSION`) rebuilt for Linux, plus `linux-x64/tree-sitter.musl.node` for
Alpine (built in Alpine; node-gyp-build loads it on musl and the glibc build everywhere else). `scripts/vendor-native.mjs` puts them in
place of the upstream Linux prebuilds when it copies the binaries into `dist/native`.

**Why:** the upstream Linux prebuilds of `tree-sitter` 0.25.1 are linked against GCC 13's libstdc++
(`GLIBCXX_3.4.31`), so they do not load on Debian 12, Ubuntu 22.04 or older systems. These are built in
Debian 11 with libstdc++ linked statically: they need glibc 2.17 or newer and nothing else, the same baseline
as the upstream grammar prebuilds (tree-sitter-php, -typescript, -javascript), which are used as published.

**Rebuild** (Docker required) after upgrading `tree-sitter`; the vendoring step refuses a version mismatch:

```bash
npm install
./scripts/build-linux-binding.sh
```

`tree-sitter/SHA256SUMS` lists the checksums of the committed files. The build is not bit-for-bit
reproducible (build IDs differ), but every rebuild is functionally the same binding. CI loads both files on
real x64 and arm64 runners (see `.github/workflows/install-matrix.yml`).

macOS and Windows use the upstream prebuilds unchanged. Alpine on arm64 has no musl build (it would need an
arm64 machine or emulation to build); on Alpine x64 the upstream grammar prebuilds load as published.
