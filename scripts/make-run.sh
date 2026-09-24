#!/bin/bash
# Wraps electron-builder's unpacked Linux output into one self-extracting .run file — the Linux
# counterpart of electron-builder's own `portable` target for Windows (see electron-builder.yml's
# win/linux sections and docs/installer.md). No third-party tool (makeself and friends) is used: the
# format here is deliberately small enough to read in one sitting.
#
#   make-run.sh <unpacked-dir> <version> <arch: x64|arm64> <out-file>
#
# The result is a POSIX sh header (everything before the line "__PAYLOAD_BELOW__") followed by a
# tar.zst of <unpacked-dir>. Running it extracts that archive to a temporary, writable, exec-allowed
# directory and starts the app with SENAWG_RUN_FILE set to its own path — src/main/setup/mode.ts's
# isSetupMode() treats that exactly like electron-builder's own PORTABLE_EXECUTABLE_FILE on Windows.
set -euo pipefail

UNPACKED=$1 VERSION=$2 ARCH=$3 OUT=$4
# electron-builder.yml's linux.executableName — the name of the binary inside the unpacked directory.
EXE=senawg
[[ -d "$UNPACKED" ]] || { echo "нет каталога $UNPACKED" >&2; exit 1; }
command -v zstd >/dev/null || { echo "нужен zstd" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PAYLOAD="$WORK/payload.tar.zst"
tar -C "$(dirname "$UNPACKED")" -cf - "$(basename "$UNPACKED")" | zstd -19 -q -o "$PAYLOAD"
SHA256=$(sha256sum "$PAYLOAD" | cut -d' ' -f1)

cat > "$OUT" <<HEADER
#!/bin/sh
# SenAWG $VERSION for Linux ($ARCH) — a self-extracting installer, not an installed program.
# Verified payload sha256: $SHA256
set -eu

die() { echo "\$*" >&2; exit 1; }

self=\$(readlink -f "\$0" 2>/dev/null || echo "\$0")
skip=\$(awk '/^__PAYLOAD_BELOW__\$/ { print NR + 1; exit }' "\$self")

command -v zstd >/dev/null || die "Нужен пакет zstd."

base=\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}}
[ -w "\$base" ] || base=\$HOME/.cache
work=\$(mktemp -d "\$base/senawg-run.XXXXXX")
trap 'rm -rf "\$work"' EXIT

actual=\$(tail -n +\$skip "\$self" | sha256sum | cut -d' ' -f1)
[ "\$actual" = "$SHA256" ] || die "Повреждённый файл: контрольная сумма не совпадает (ожидалась $SHA256, получена \$actual)."

tail -n +\$skip "\$self" | zstd -dq | tar -C "\$work" -xf -
app="\$work/$(basename "$UNPACKED")/$EXE"

if [ "\$(id -u)" = "0" ] || { [ -z "\${DISPLAY:-}" ] && [ -z "\${WAYLAND_DISPLAY:-}" ]; }; then
  # No desktop session, or run as root by hand (sudo ./SenAWG.run): the installer plays out in the
  # terminal instead of opening a window (src/main/setup — --setup with no window, see docs/linux.md).
  exec env SENAWG_RUN_FILE="\$self" "\$app" --setup --no-window "\$@"
fi

# --no-sandbox: Chromium's setuid sandbox cannot work from a freshly extracted, world-writable temporary
# directory, and user namespaces (the unprivileged alternative) are locked down by AppArmor on some
# distributions (Ubuntu 24.04+) for exactly this shape of launch. The window this draws is the setup
# screen alone (src/renderer/installer); nothing it shows comes from the network.
exec env SENAWG_RUN_FILE="\$self" "\$app" --no-sandbox --setup "\$@"
HEADER
printf '__PAYLOAD_BELOW__\n' >> "$OUT"
cat "$PAYLOAD" >> "$OUT"
chmod 755 "$OUT"
echo "Готово: $OUT"
