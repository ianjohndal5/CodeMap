#!/usr/bin/env bash
# Build the Linux binaries in native-prebuilds/ (native-prebuilds/README.md says why they replace upstream's):
#   tree-sitter (the core binding), Node-API 8: linux-x64 (glibc and musl) and linux-arm64
#   tree-sitter-typescript: linux-arm64
#
# glibc builds are made in Debian 11 with libstdc++ linked statically: they need glibc 2.17 or newer and
# nothing else, the same baseline as the upstream grammar prebuilds. arm64 is cross-compiled with Debian's
# aarch64 toolchain. The musl build (linux-x64/tree-sitter.musl.node, which node-gyp-build loads on Alpine) is
# made in Alpine. macOS and Windows binaries need those systems: .github/workflows/native-prebuilds.yml builds
# them, and runs this script for Linux.
#
# Needs Docker and `npm ci` (the packages in node_modules are the sources). OUT sets the output directory.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mkdir -p "${OUT:-$root/native-prebuilds}" && cd "${OUT:-$root/native-prebuilds}" && pwd)"

build() { # <package> <platform> <output file> <docker setup> <env> <node-gyp arch> <strip> [image]
  mkdir -p "$out/$1/$2"
  docker run --rm \
    -v "$root/node_modules/$1:/src/pkg:ro" \
    -v "$root/node_modules/node-addon-api:/src/node-addon-api:ro" \
    -v "$out/$1/$2:/out" \
    "${8:-node:20-bullseye}" sh -c "
      set -e
      $4
      mkdir -p /tmp/b/node_modules
      cp -r /src/pkg /tmp/b/pkg
      cp -r /src/node-addon-api /tmp/b/node_modules/node-addon-api
      cd /tmp/b/pkg
      env $5 LDFLAGS='-static-libstdc++ -static-libgcc' npx --yes node-gyp@12 rebuild --arch=$6 --nodedir=/usr/local --napi_build_version=8 > /tmp/build.log 2>&1 || { tail -40 /tmp/build.log; exit 1; }
      $7 --strip-unneeded build/Release/*_binding.node
      cp build/Release/*_binding.node /out/$3
      chown $(id -u):$(id -g) /out/$3
    "
  node -p "require('$root/node_modules/$1/package.json').version" > "$out/$1/VERSION"
}

arm64_setup='apt-get update -qq > /dev/null && apt-get install -y -qq g++-aarch64-linux-gnu > /dev/null'
arm64_env='CC=aarch64-linux-gnu-gcc CXX=aarch64-linux-gnu-g++ LINK=aarch64-linux-gnu-g++'

build tree-sitter linux-x64 tree-sitter.node ':' '' x64 strip
build tree-sitter linux-arm64 tree-sitter.node "$arm64_setup" "$arm64_env" arm64 aarch64-linux-gnu-strip
build tree-sitter linux-x64 tree-sitter.musl.node 'apk add --no-cache -q python3 make g++ binutils' '' x64 strip node:20-alpine
build tree-sitter-typescript linux-arm64 tree-sitter-typescript.node "$arm64_setup" "$arm64_env" arm64 aarch64-linux-gnu-strip

(cd "$out" && find . -name '*.node' | sed 's|^\./||' | LC_ALL=C sort | xargs sha256sum > SHA256SUMS)
cat "$out/SHA256SUMS"
