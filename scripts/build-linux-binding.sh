#!/usr/bin/env bash
# Rebuild the Tree-sitter core binding for Linux (x64 and arm64) into native-prebuilds/tree-sitter.
#
# Why: the upstream prebuilds of tree-sitter 0.25.1 for Linux are linked against GCC 13's libstdc++
# (GLIBCXX_3.4.31), so they fail to load on Debian 12, Ubuntu 22.04 and older. These are built in
# Debian 11 with libstdc++ linked statically: they need glibc 2.17 or newer and nothing else, the same
# baseline as the upstream grammar prebuilds. arm64 is cross-compiled with Debian's aarch64 toolchain.
# A musl build for Alpine (linux-x64/tree-sitter.musl.node) is made in Alpine itself: node-gyp-build loads
# it on musl and the glibc one elsewhere.
#
# Needs Docker and an `npm install` (node_modules/tree-sitter and node-addon-api are the sources).
# Run it after upgrading tree-sitter; scripts/vendor-native.mjs refuses a version mismatch.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$root/node_modules/tree-sitter/package.json').version")"
out="$root/native-prebuilds/tree-sitter"
mkdir -p "$out/linux-x64" "$out/linux-arm64"

build() { # <platform> <docker setup> <env> <node-gyp arch> <strip> [image] [output file]
  docker run --rm \
    -v "$root/node_modules/tree-sitter:/src/tree-sitter:ro" \
    -v "$root/node_modules/node-addon-api:/src/node-addon-api:ro" \
    -v "$out/$1:/out" \
    "${6:-node:20-bullseye}" sh -c "
      set -e
      $2
      mkdir -p /tmp/b/node_modules
      cp -r /src/tree-sitter /tmp/b/ts
      cp -r /src/node-addon-api /tmp/b/node_modules/node-addon-api
      cd /tmp/b/ts
      env $3 LDFLAGS='-static-libstdc++ -static-libgcc' npx --yes node-gyp@11 rebuild --arch=$4 --nodedir=/usr/local --napi_build_version=8 > /tmp/build.log 2>&1 || { tail -40 /tmp/build.log; exit 1; }
      $5 --strip-unneeded build/Release/tree_sitter_runtime_binding.node
      cp build/Release/tree_sitter_runtime_binding.node /out/${7:-tree-sitter.node}
      chown $(id -u):$(id -g) /out/${7:-tree-sitter.node}
    "
}

build linux-x64 ':' '' x64 strip
build linux-arm64 'apt-get update -qq > /dev/null && apt-get install -y -qq g++-aarch64-linux-gnu > /dev/null' \
  'CC=aarch64-linux-gnu-gcc CXX=aarch64-linux-gnu-g++ LINK=aarch64-linux-gnu-g++' arm64 aarch64-linux-gnu-strip
build linux-x64 'apk add --no-cache -q python3 make g++ binutils' '' x64 strip node:20-alpine tree-sitter.musl.node

echo "$version" > "$out/VERSION"
(cd "$out" && sha256sum linux-*/tree-sitter*.node > SHA256SUMS)
echo "built tree-sitter $version for linux-x64 (glibc, musl) and linux-arm64 (glibc) in native-prebuilds/tree-sitter"
cat "$out/SHA256SUMS"
