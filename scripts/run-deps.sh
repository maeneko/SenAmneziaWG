# What SenAWG needs from the system before it can even start, and how to tell the person what is missing:
# the package, and the command that installs it. make-run.sh puts this file verbatim into the .run's
# header, so it is POSIX sh and only defines functions (prefixed senawg_, not to collide with the
# header's own variables). The families and the way they are told apart match src/main/linuxPackages.ts,
# which says the same about what the running application needs (pkexec, zstd).
#
# The awg-helper and amneziawg-go binaries are static: only the Electron application itself needs these.

# arch | artix | debian | fedora | suse, or nothing: os-release's ID, then its ID_LIKE. SENAWG_OS_RELEASE
# is for tests/runDeps.test.ts.
senawg_family() {
  (
    for f in ${SENAWG_OS_RELEASE:-/etc/os-release /usr/lib/os-release}; do
      [ -r "$f" ] && { . "$f"; break; }
    done
    [ "${ID:-}" = artix ] && { echo artix; exit; }
    for id in ${ID:-} ${ID_LIKE:-}; do
      case $id in
        arch | archlinux) echo arch; exit ;;
        debian | ubuntu) echo debian; exit ;;
        fedora | rhel | centos) echo fedora; exit ;;
        suse | opensuse*) echo suse; exit ;;
      esac
    done
  )
}

senawg_install_cmd() {
  case $1 in
    arch | artix) echo "sudo pacman -S --needed" ;;
    debian) echo "sudo apt install" ;;
    fedora) echo "sudo dnf install" ;;
    suse) echo "sudo zypper install" ;;
  esac
}

# The libraries the Electron binary links against (its DT_NEEDED entries, glibc's own aside), and the
# package each comes in: Arch (and Artix), Debian/Ubuntu, Fedora, openSUSE.
senawg_lib_table() {
  cat <<'TABLE'
libglib-2.0.so.0        glib2          libglib2.0-0        glib2          libglib-2_0-0
libgobject-2.0.so.0     glib2          libglib2.0-0        glib2          libgobject-2_0-0
libgio-2.0.so.0         glib2          libglib2.0-0        glib2          libgio-2_0-0
libnspr4.so             nspr           libnspr4            nspr           mozilla-nspr
libnss3.so              nss            libnss3             nss            mozilla-nss
libnssutil3.so          nss            libnss3             nss-util       mozilla-nss
libsmime3.so            nss            libnss3             nss            mozilla-nss
libatk-1.0.so.0         at-spi2-core   libatk1.0-0         atk            libatk-1_0-0
libatk-bridge-2.0.so.0  at-spi2-core   libatk-bridge2.0-0  at-spi2-atk    libatk-bridge-2_0-0
libatspi.so.0           at-spi2-core   libatspi2.0-0       at-spi2-core   libatspi0
libcups.so.2            libcups        libcups2            cups-libs      libcups2
libdbus-1.so.3          dbus           libdbus-1-3         dbus-libs      libdbus-1-3
libcairo.so.2           cairo          libcairo2           cairo          libcairo2
libgtk-3.so.0           gtk3           libgtk-3-0          gtk3           libgtk-3-0
libpango-1.0.so.0       pango          libpango-1.0-0      pango          libpango-1_0-0
libX11.so.6             libx11         libx11-6            libX11         libX11-6
libXcomposite.so.1      libxcomposite  libxcomposite1      libXcomposite  libXcomposite1
libXdamage.so.1         libxdamage     libxdamage1         libXdamage     libXdamage1
libXext.so.6            libxext        libxext6            libXext        libXext6
libXfixes.so.3          libxfixes      libxfixes3          libXfixes      libXfixes3
libXrandr.so.2          libxrandr      libxrandr2          libXrandr      libXrandr2
libgbm.so.1             mesa           libgbm1             mesa-libgbm    libgbm1
libexpat.so.1           expat          libexpat1           expat          libexpat1
libxcb.so.1             libxcb         libxcb1             libxcb         libxcb1
libxkbcommon.so.0       libxkbcommon   libxkbcommon0       libxkbcommon   libxkbcommon0
libudev.so.1            systemd-libs   libudev1            systemd-libs   libudev1
libasound.so.2          alsa-lib       libasound2          alsa-lib       libasound2
libgcc_s.so.1           gcc-libs       libgcc-s1           libgcc         libgcc_s1
TABLE
}

# senawg_package <family> <library>: the package, or nothing when the library is not in the table.
senawg_package() {
  # Artix has no systemd: its libudev is a package of its own.
  [ "$1:$2" = artix:libudev.so.1 ] && { echo libudev; return; }
  case $1 in
    arch | artix) col=2 ;;
    debian) col=3 ;;
    fedora) col=4 ;;
    suse) col=5 ;;
    *) return 0 ;; # a bare return would pass on the test above failing, and set -e stops the .run
  esac
  pkg=$(senawg_lib_table | awk -v lib="$2" -v col="$col" '$1 == lib { print $col; exit }')
  # Debian 13 and Ubuntu 24.04 renamed some for the 64-bit time_t transition (libgtk-3-0t64 …); the old
  # name is then no longer installable.
  if [ "$1" = debian ] && [ -n "$pkg" ] && apt-cache show "${pkg}t64" >/dev/null 2>&1; then
    pkg=${pkg}t64
  fi
  echo "$pkg"
}

# senawg_hint <package>: «zstd: sudo pacman -S --needed zstd», or the name alone for an unknown family.
senawg_hint() {
  cmd=$(senawg_install_cmd "$(senawg_family)")
  if [ -n "$cmd" ]; then echo "$1: $cmd $1"; else echo "$1"; fi
}

# The message goes to the terminal, and — the .run is as often double-clicked — to a window, with the
# first of the usual tools that is there and still starts (zenity itself needs gtk, which may be what
# is missing).
senawg_tell() {
  echo "$1" >&2
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || return 0
  zenity --error --no-wrap --title=SenAWG --text="$1" 2>/dev/null && return 0
  kdialog --title SenAWG --error "$1" 2>/dev/null && return 0
  notify-send -u critical SenAWG "$1" 2>/dev/null && return 0
  xmessage -center "$1" 2>/dev/null || true
}

# The oldest glibc the Electron binary runs on: the newest GLIBC_ symbol version it asks for.
SENAWG_GLIBC_MIN=2.25

# senawg_missing <app>: prints what is missing (a message for senawg_tell), or nothing when all is there.
senawg_missing() {
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }')
  if [ -z "$glibc" ]; then
    echo "SenAWG работает только на системах с glibc; на musl (Alpine, Void musl) он не запустится."
    return
  fi
  if ! awk -v have="$glibc" -v need="$SENAWG_GLIBC_MIN" 'BEGIN {
    split(have, h, "."); split(need, n, ".")
    exit !(h[1] > n[1] || (h[1] == n[1] && h[2] + 0 >= n[2] + 0))
  }'; then
    echo "Нужна glibc $SENAWG_GLIBC_MIN или новее, в системе — $glibc: эта версия дистрибутива слишком старая для SenAWG."
    return
  fi

  command -v ldd >/dev/null 2>&1 || return 0
  libs=$(ldd "$1" 2>/dev/null | awk '/=> not found/ { print $1 }' | sort -u)
  [ -n "$libs" ] || return 0

  family=$(senawg_family)
  pkgs=
  unknown=
  for lib in $libs; do
    pkg=$(senawg_package "$family" "$lib")
    if [ -z "$pkg" ]; then
      unknown="$unknown $lib"
    else
      case " $pkgs " in *" $pkg "*) ;; *) pkgs="$pkgs $pkg" ;; esac
    fi
  done
  cmd=$(senawg_install_cmd "$family")

  echo "Не хватает системных библиотек, без них SenAWG не запустится:"
  echo "  $(echo $libs)"
  if [ -n "$pkgs" ] && [ -n "$cmd" ]; then
    echo "Установите их:"
    echo "  $cmd$pkgs"
  fi
  [ -z "$unknown" ] || echo "Пакеты для$unknown найдите в репозитории своего дистрибутива."
}
