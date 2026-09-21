#!/bin/bash
# Builds the amneziawg-go daemon that ships inside SenAWG.app (Contents/Resources/bin).
# Pinned to an upstream tag *and* its commit, so a moved tag cannot change what we bundle.
# Output: resources/bin/amneziawg-go — a universal (arm64 + x86_64) macOS binary.
set -euo pipefail

TAG=v3.1.20260828
COMMIT=b5928efb6ca19f0153958460c3d141f04abc5c2e
REPO=https://github.com/amnezia-vpn/amneziawg-go.git
MIN_MACOS=11.0

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT_DIR=$ROOT/resources/bin
OUT=$OUT_DIR/amneziawg-go

command -v go >/dev/null || { echo "Нужен Go (brew install go)" >&2; exit 1; }

if [[ -x "$OUT" && "$("$OUT" --version 2>/dev/null | head -1)" == "amneziawg-go $TAG" && "${1:-}" != "--force" ]]; then
  echo "amneziawg-go $TAG уже собран: $OUT (--force для пересборки)"
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" "$REPO" "$WORK/src"
actual=$(git -C "$WORK/src" rev-parse HEAD)
[[ "$actual" == "$COMMIT" ]] || { echo "Тег $TAG указывает на $actual, ожидался $COMMIT — сборка остановлена" >&2; exit 1; }

cd "$WORK/src"
printf 'package main\n\nconst Version = "%s"\n' "$TAG" > version.go

for arch in arm64 amd64; do
  echo "→ darwin/$arch"
  CGO_ENABLED=0 GOOS=darwin GOARCH=$arch MACOSX_DEPLOYMENT_TARGET=$MIN_MACOS \
    go build -trimpath -ldflags='-s -w' -o "$WORK/amneziawg-go-$arch" .
done

mkdir -p "$OUT_DIR"
lipo -create -output "$WORK/amneziawg-go" "$WORK/amneziawg-go-arm64" "$WORK/amneziawg-go-amd64"
# Ad-hoc signature: arm64 refuses to run unsigned code. electron-builder re-signs it with the app identity.
codesign --force --sign - "$WORK/amneziawg-go"
install -m 755 "$WORK/amneziawg-go" "$OUT"

echo "Готово: $OUT"
lipo -info "$OUT"
"$OUT" --version | head -1
