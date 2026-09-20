#!/bin/bash
# Privileged helper for AmnesiaWG (macOS). Must run as root.
#
#   awg.sh up   --id ID --uid UID --bin PATH --body FILE --endpoint-ip IP
#               --address CIDR[,CIDR] --allowed CIDR[,CIDR] [--mtu N] [--dns IP[,IP]] [--diagnostics 1]
#   awg.sh down
#
# State lives in a root-owned directory so this script never trusts user-writable input
# when tearing down (pid, interface, DNS backup, routes).
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/bin:/sbin

STATE_DIR=/var/db/amnesiawg
STATE_FILE=$STATE_DIR/state.env
UAPI_DIR=/var/run/amneziawg

die() { echo "$*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

# --- state -----------------------------------------------------------------

ID=""; IFACE=""; PID=""; SOCK=""; NAMEFILE=""
EP_IP=""; EP_ROUTE=""; DNS_SERVICE=""; DNS_OLD=""; MONITOR_PID=""
BODY=""; OK=0
# Gateway the endpoint route currently points at (monitor-local, never persisted).
EP_GW=""

save_state() {
  {
    printf 'ID=%q\n' "$ID"
    printf 'IFACE=%q\n' "$IFACE"
    printf 'PID=%q\n' "$PID"
    printf 'SOCK=%q\n' "$SOCK"
    printf 'NAMEFILE=%q\n' "$NAMEFILE"
    printf 'EP_IP=%q\n' "$EP_IP"
    printf 'EP_ROUTE=%q\n' "$EP_ROUTE"
    printf 'DNS_SERVICE=%q\n' "$DNS_SERVICE"
    printf 'DNS_OLD=%q\n' "$DNS_OLD"
    printf 'MONITOR_PID=%q\n' "$MONITOR_PID"
  } > "$STATE_FILE.tmp"
  chmod 644 "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

is_daemon() {
  [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null && [[ "$(ps -p "$1" -o comm= 2>/dev/null)" == *amneziawg-go* ]]
}

is_monitor() {
  [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null && [[ "$(ps -p "$1" -o command= 2>/dev/null)" == *awg.sh* ]]
}

# SIGKILL for monitors: when launched through the macOS admin prompt they may inherit an ignored
# SIGTERM, and they hold no state that needs a graceful exit. Their `route -n monitor` goes too.
kill_monitor() {
  is_monitor "$1" || return 0
  pkill -9 -P "$1" 2>/dev/null || true
  kill -9 "$1" 2>/dev/null || true
}

# Monitors of earlier sessions that outlived their daemon (see kill_monitor): an awg.sh process whose
# child is `route -n monitor`. Only called when no tunnel of ours is running.
reap_orphan_monitors() {
  local ppid cmd
  # `if`, not `&&`: a false test as the loop's last command would fail the pipeline under set -e.
  ps -axo ppid=,command= | while read -r ppid cmd; do
    if [[ "$cmd" == "route -n monitor" ]]; then kill_monitor "$ppid"; fi
  done
}

# Best-effort: every step is allowed to fail so teardown always runs to the end.
teardown() {
  # First, so it cannot re-pin the endpoint route we are about to delete.
  kill_monitor "$MONITOR_PID"
  if [[ -n "$DNS_SERVICE" ]]; then
    # shellcheck disable=SC2086
    networksetup -setdnsservers "$DNS_SERVICE" ${DNS_OLD:-Empty} >/dev/null 2>&1 || warn "не удалось вернуть DNS"
    dscacheutil -flushcache 2>/dev/null || true
    killall -HUP mDNSResponder 2>/dev/null || true
  fi
  if [[ -n "$EP_ROUTE" && -n "$EP_IP" ]]; then
    if [[ "$EP_IP" == *:* ]]; then
      route -q -n delete -inet6 -host "$EP_IP" >/dev/null 2>&1 || true
    else
      route -q -n delete -inet -host "$EP_IP" >/dev/null 2>&1 || true
    fi
  fi
  if is_daemon "$PID"; then
    kill "$PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$PID" 2>/dev/null || true
  fi
  [[ -n "$SOCK" ]] && rm -f "$SOCK"
  [[ -n "$NAMEFILE" ]] && rm -f "$NAMEFILE"
  return 0
}

# --- helpers ---------------------------------------------------------------

# Sends a UAPI request body from a file and waits for the errno= line (the daemon never closes first).
uapi_send() {
  /usr/bin/perl -MIO::Socket::UNIX -e '
    alarm 10;
    my ($path, $file) = @ARGV;
    my $s = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $path) or die "connect: $!\n";
    open(my $f, "<", $file) or die "open: $!\n";
    local $/; my $body = <$f>; close $f;
    print $s $body; $s->flush;
    $/ = "\n";
    while (my $line = <$s>) {
      if ($line =~ /^errno=(-?\d+)/) { exit($1 == 0 ? 0 : 1); }
    }
    die "no errno in response\n";
  ' "$1" "$2"
}

route_field() { # route_field <field> <args to route get>
  local field=$1; shift
  route -n get "$@" 2>/dev/null | awk -v f="$field:" '$1 == f { print $2; exit }'
}

service_for_iface() {
  networksetup -listnetworkserviceorder | awk -v dev="$1" '
    /^\([0-9]+\) / { name = $0; sub(/^\([0-9]+\) /, "", name) }
    /Device: / {
      if (match($0, /Device: [^)]*/)) {
        d = substr($0, RSTART + 8, RLENGTH - 8)
        if (d == dev) { print name; exit }
      }
    }'
}

valid_list() { [[ "$1" =~ ^[0-9A-Fa-f:./,]+$ ]]; }

ep_family() { if [[ "$EP_IP" == *:* ]]; then echo inet6; else echo inet; fi; }

# "<gateway> <interface>" of the physical default route. Tunnels — ours, another VPN's, or macOS's own
# utun/ipsec ones — install default routes too (to link#N or fe80::%utunN); skip them so the endpoint
# always goes out over the real network.
physical_default() {
  netstat -nr -f "$1" 2>/dev/null |
    awk '$1 == "default" && $2 !~ /^link#/ && $4 !~ /^(utun|ipsec)[0-9]/ { print $2, $4; exit }'
}

# Points the host route for the server at the current physical gateway. Without a gateway (network
# down) it blackholes the endpoint instead: otherwise its packets would fall into 0/1 and loop
# through our own tunnel. With "force" it rebuilds the route even if it looks right — after sleep or
# a Wi-Fi rejoin the old route can keep a stale interface address and every send fails with
# EADDRNOTAVAIL.
pin_endpoint() {
  local force=${1:-} fam gw want current
  fam=$(ep_family)
  IFS=' ' read -r gw _ < <(physical_default "$fam") || true
  if [[ -n "$gw" ]]; then want=$gw; elif [[ $fam == inet6 ]]; then want=::1; else want=127.0.0.1; fi
  current=$(route_field gateway "-$fam" "$EP_IP" || true)
  [[ -z "$force" && "$current" == "$want" && "$EP_GW" == "$want" ]] && return 0

  route -q -n delete "-$fam" -host "$EP_IP" >/dev/null 2>&1 || true
  if [[ -n "$gw" ]]; then
    route -q -n add "-$fam" -host "$EP_IP" "$gw" >/dev/null 2>&1 || return 1
  else
    route -q -n add "-$fam" -host "$EP_IP" "$want" -blackhole >/dev/null 2>&1 || return 1
  fi
  EP_GW=$want
  EP_ROUTE=1
}

# Diagnostic: 25 s packet capture right after connect, headers only (first 96 bytes: IP + TCP/UDP
# headers, no payload), as pcap files the app can read without root (`tcpdump -r`). Inside the tunnel:
# everything. Outside: UDP to/from the server. -G/-W make tcpdump stop by itself after 25 s.
start_capture() {
  local phys_if=$1 f
  for f in capture-inner capture-outer; do rm -f "$STATE_DIR/$f".{txt,pcap}; done
  tcpdump -n -i "$IFACE" -s 96 -G 25 -W 1 -w "$STATE_DIR/capture-inner.pcap" \
    >/dev/null 2>"$STATE_DIR/capture-inner.txt" </dev/null &
  disown $! 2>/dev/null || true
  tcpdump -n -i "$phys_if" -s 96 -G 25 -W 1 -w "$STATE_DIR/capture-outer.pcap" "udp and host $EP_IP" \
    >/dev/null 2>"$STATE_DIR/capture-outer.txt" </dev/null &
  disown $! 2>/dev/null || true
  # Who else reacts to our tunnel: owners of every utun, firewall state, routes — 8 s after connect.
  (
    sleep 8
    {
      echo "### utun owners (lsof as root)"
      lsof -nP 2>/dev/null | grep 'com.apple.net.utun_control' | awk '{print $1, $2, $3, $(NF-1), $NF}' | sort -u
      echo "### utun interfaces"
      for u in $(ifconfig -l); do [[ $u == utun* ]] && echo "$u $(ifconfig "$u" | awk '/inet /{print $2, $3, $4}')"; done
      echo "### pf"; pfctl -s info 2>&1 | grep -E 'Status'; pfctl -a '*' -sr 2>&1 | head -60; pfctl -s nat 2>&1 | head -20
      echo "### routes"; netstat -rnl -f inet | head -40
      echo "### processes"; pgrep -ilf 'amnezia|radio|relay'
    } >"$STATE_DIR/snapshot.txt" 2>&1
    chmod 644 "$STATE_DIR/snapshot.txt"
  ) >/dev/null 2>&1 </dev/null &
  disown $! 2>/dev/null || true
}

# Background re-pinning for the lifetime of the daemon (the same approach as wg-quick's monitor).
# Route add/delete events — including our own — only re-pin when something actually differs;
# interface events (address or link changes) always force a rebuild.
monitor_loop() {
  set +e
  exec 19< <(exec route -n monitor)
  local mon=$! line force rc
  trap 'kill "$mon" 2>/dev/null' EXIT
  while true; do
    # Wake up at least every 5 s: the monitor must end with the daemon even if nothing on the network
    # changes and teardown's kill never reaches it.
    read -r -t 5 -u 19 line
    rc=$?
    is_daemon "$PID" || break
    ((rc > 128)) && continue # timeout
    ((rc != 0)) && break     # route monitor went away
    [[ $line == RTM_* ]] || continue
    force=
    [[ $line == RTM_NEWADDR* || $line == RTM_DELADDR* || $line == RTM_IFINFO* ]] && force=force
    # An interface change arrives as a burst; wait for it to settle.
    while read -r -t 1 -u 19 line; do
      [[ $line == RTM_NEWADDR* || $line == RTM_DELADDR* || $line == RTM_IFINFO* ]] && force=force
    done
    pin_endpoint "$force"
  done
}

# --- up --------------------------------------------------------------------

cmd_up() {
  local uid="" bin="" address="" allowed="" mtu="1280" dns="" diagnostics="" replace=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) ID=$2 ;;
      --uid) uid=$2 ;;
      --bin) bin=$2 ;;
      --body) BODY=$2 ;;
      --endpoint-ip) EP_IP=$2 ;;
      --address) address=$2 ;;
      --allowed) allowed=$2 ;;
      --mtu) mtu=$2 ;;
      --dns) dns=$2 ;;
      --diagnostics) diagnostics=$2 ;;
      --replace) replace=$2 ;;
      *) die "неизвестный аргумент: $1" ;;
    esac
    shift 2 || die "у аргумента нет значения"
  done

  # The body file holds the private key: remove it however we exit.
  trap 'rm -f "$BODY"' EXIT

  [[ "$uid" =~ ^[0-9]+$ ]] || die "некорректный uid"
  [[ "$mtu" =~ ^[0-9]+$ ]] || die "некорректный MTU"
  [[ "$ID" =~ ^[0-9A-Za-z-]+$ ]] || die "некорректный id туннеля"
  [[ -x "$bin" ]] || die "не найден исполняемый файл amneziawg-go: $bin"
  [[ -f "$BODY" ]] || die "не найден файл конфигурации"
  [[ "$EP_IP" =~ ^[0-9A-Fa-f:.]+$ ]] || die "некорректный IP сервера"
  valid_list "$address" || die "некорректный Address"
  valid_list "$allowed" || die "некорректный AllowedIPs"
  [[ -z "$dns" ]] || valid_list "$dns" || die "некорректный DNS"

  mkdir -p "$STATE_DIR" "$UAPI_DIR"
  chmod 755 "$STATE_DIR"

  if [[ -f "$STATE_FILE" ]]; then
    # Subshell: the old state must not overwrite the arguments we just parsed.
    # shellcheck source=/dev/null
    if ( source "$STATE_FILE"; is_daemon "$PID" ); then
      # Switching servers: stop the running tunnel here, so the whole switch needs one admin prompt.
      # If the new one then fails, the EXIT trap tears it down and the Mac is left without a tunnel.
      [[ "$replace" == 1 ]] || die "Туннель уже активен"
    else
      warn "найдено устаревшее состояние, очищаю"
    fi
    # shellcheck source=/dev/null
    ( source "$STATE_FILE"; teardown )
    rm -f "$STATE_FILE"
  fi
  reap_orphan_monitors

  # From here on the state file is ours: undo a half-built tunnel on any failure. Not earlier —
  # refusing to start over a running tunnel must leave that tunnel's state file alone.
  trap 'rm -f "$BODY"; [[ "$OK" == 1 ]] || { teardown; rm -f "$STATE_FILE"; }' EXIT

  # The real network the endpoint route (and DNS) will use; it must stay outside the tunnel.
  local gw ep_if
  IFS=' ' read -r gw ep_if < <(physical_default "$(ep_family)") || true
  [[ -n "$gw" && -n "$ep_if" ]] || die "Нет подключения к сети — не найден основной шлюз"

  NAMEFILE=$(mktemp "$STATE_DIR/name.XXXXXX")
  # A fresh file (new inode) that the app can read without root: the Logs tab follows it.
  rm -f "$STATE_DIR/daemon.log"
  install -m 644 /dev/null "$STATE_DIR/daemon.log"
  WG_TUN_NAME_FILE="$NAMEFILE" LOG_LEVEL=debug "$bin" -f utun >>"$STATE_DIR/daemon.log" 2>&1 </dev/null &
  PID=$!
  disown "$PID" 2>/dev/null || true
  save_state

  local i
  for ((i = 0; i < 50; i++)); do
    kill -0 "$PID" 2>/dev/null || die "amneziawg-go завершился при запуске: $(tail -n 3 "$STATE_DIR/daemon.log" 2>/dev/null)"
    IFACE=$(tr -d '[:space:]' < "$NAMEFILE" 2>/dev/null || true)
    [[ -n "$IFACE" && -S "$UAPI_DIR/$IFACE.sock" ]] && break
    sleep 0.2
  done
  [[ -n "$IFACE" && -S "$UAPI_DIR/$IFACE.sock" ]] || die "Интерфейс не поднялся за 10 секунд"
  SOCK=$UAPI_DIR/$IFACE.sock
  save_state

  # Hand the socket to the calling user so stats can be polled without root.
  chown "$uid" "$SOCK"

  uapi_send "$SOCK" "$BODY" || die "amneziawg-go отклонил конфигурацию: $(tail -n 3 "$STATE_DIR/daemon.log" 2>/dev/null)"
  rm -f "$BODY"

  # Comma lists are split into arrays: changing IFS for the rest of the function would leak into
  # every later `read` (it once glued the interface name onto the endpoint gateway).
  local a cidr addrs cidrs
  IFS=, read -r -a addrs <<< "$address"
  IFS=, read -r -a cidrs <<< "$allowed"
  for a in "${addrs[@]}"; do
    if [[ "$a" == *:* ]]; then
      ifconfig "$IFACE" inet6 "$a" alias || warn "не удалось назначить $a"
    else
      ifconfig "$IFACE" inet "$a" "${a%%/*}" alias || die "не удалось назначить адрес $a"
    fi
  done
  ifconfig "$IFACE" mtu "$mtu" up

  EP_ROUTE=1 # before pinning: a half-added route must still be removed on failure
  save_state
  pin_endpoint force || die "не удалось добавить маршрут до сервера"

  for cidr in "${cidrs[@]}"; do
    case "$cidr" in
      0.0.0.0/0)
        route -q -n add -inet 0.0.0.0/1 -interface "$IFACE" || die "не удалось направить трафик в туннель"
        route -q -n add -inet 128.0.0.0/1 -interface "$IFACE" || die "не удалось направить трафик в туннель" ;;
      ::/0)
        route -q -n add -inet6 ::/1 -interface "$IFACE" >/dev/null 2>&1 || warn "IPv6-маршрут не добавлен"
        route -q -n add -inet6 8000::/1 -interface "$IFACE" >/dev/null 2>&1 || warn "IPv6-маршрут не добавлен" ;;
      *:*) route -q -n add -inet6 "$cidr" -interface "$IFACE" >/dev/null 2>&1 || warn "не удалось добавить $cidr" ;;
      *) route -q -n add -inet "$cidr" -interface "$IFACE" || die "не удалось добавить маршрут $cidr" ;;
    esac
  done

  if [[ -n "$dns" ]]; then
    local svc
    svc=$(service_for_iface "$ep_if" || true)
    if [[ -n "$svc" ]]; then
      DNS_OLD=$(networksetup -getdnsservers "$svc" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')
      [[ "$DNS_OLD" == *"aren't any"* || -z "$DNS_OLD" ]] && DNS_OLD=Empty
      DNS_SERVICE=$svc
      save_state
      # shellcheck disable=SC2086
      networksetup -setdnsservers "$svc" ${dns//,/ } || warn "не удалось выставить DNS"
      dscacheutil -flushcache 2>/dev/null || true
      killall -HUP mDNSResponder 2>/dev/null || true
    else
      warn "не найден сетевой сервис для $ep_if — DNS не изменён"
    fi
  fi

  # Opt-in (Logs → «Диагностика подключения»): packet capture and a root snapshot of who else
  # touches the network.
  if [[ "$diagnostics" == 1 ]]; then
    start_capture "$ep_if" || warn "диагностический захват пакетов не запущен"
  else
    rm -f "$STATE_DIR"/capture-inner.{txt,pcap} "$STATE_DIR"/capture-outer.{txt,pcap} "$STATE_DIR/snapshot.txt"
  fi

  monitor_loop >/dev/null 2>&1 </dev/null &
  MONITOR_PID=$!
  disown "$MONITOR_PID" 2>/dev/null || true

  save_state
  OK=1
  echo "IFACE=$IFACE"
}

# --- down ------------------------------------------------------------------

cmd_down() {
  reap_orphan_monitors
  [[ -f "$STATE_FILE" ]] || { echo "Туннель не активен"; return 0; }
  # shellcheck source=/dev/null
  source "$STATE_FILE"
  teardown
  rm -f "$STATE_FILE"
  echo "Туннель остановлен"
}

# Sourced by tests (AWG_SH_LIB=1) for its functions only.
[[ -n "${AWG_SH_LIB:-}" ]] && return 0

# The macOS admin prompt can start us with SIGTERM/SIGALRM ignored, and a non-interactive bash cannot
# undo that: `kill` would not stop the monitor and `read -t` would never time out. Re-exec once with
# default dispositions (they survive exec).
if [[ -z "${AWG_SIGNALS_RESET:-}" ]]; then
  export AWG_SIGNALS_RESET=1
  exec /usr/bin/perl -e '$SIG{$_} = "DEFAULT" for qw(TERM ALRM INT HUP QUIT PIPE); exec @ARGV or die "exec: $!\n"' \
    /bin/bash "$0" "$@"
fi

[[ $EUID -eq 0 ]] || die "Скрипт нужно запускать с правами администратора"

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) cmd_down ;;
  *) die "использование: awg.sh up|down" ;;
esac
