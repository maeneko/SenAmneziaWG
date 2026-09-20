import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Full `cmd_up` → `cmd_down` without root: privileged commands are shell-function stubs that record
 * their arguments, state lives in a temp dir, and a fake amneziawg-go serves UAPI on a real socket.
 * Runs under the script's own `set -euo pipefail`, so a silent abort fails this test.
 */
const SCRIPT = resolve('resources/scripts/awg.sh')
let dir: string
let calls: string[]
let uapi: string
let upOut: string
let stateAfterUp: string

const FAKE_DAEMON = `#!/usr/bin/env python3
import os, socket
open(os.environ['WG_TUN_NAME_FILE'], 'w').write('utun99\\n')
srv = socket.socket(socket.AF_UNIX); srv.bind(os.path.join(os.environ['FAKE_UAPI_DIR'], 'utun99.sock')); srv.listen(5)
while True:
    c, _ = srv.accept(); data = b''
    while not data.endswith(b'\\n\\n'):
        chunk = c.recv(4096)
        if not chunk: break
        data += chunk
    open(os.path.join(os.environ['FAKE_UAPI_DIR'], 'received.txt'), 'ab').write(data)
    c.sendall(b'errno=0\\n\\n'); c.close()
`

function sh(body: string): { out: string; code: number | null } {
  const r = spawnSync('/bin/bash', ['-c', `
set -euo pipefail
D=${JSON.stringify(dir)}
AWG_SH_LIB=1 source ${JSON.stringify(SCRIPT)}
set -euo pipefail
STATE_DIR=$D/state; STATE_FILE=$STATE_DIR/state.env; UAPI_DIR=$D/run
export FAKE_UAPI_DIR=$UAPI_DIR
rec() { local IFS=' '; echo "$*" >> "$D/calls"; }
ifconfig() { rec ifconfig "$@"; }
chown() { rec chown "$@"; }
dscacheutil() { :; }
killall() { :; }
netstat() { printf 'default link#22 UCSg utun4\\ndefault 10.0.0.1 UGScIg en0\\n'; }
route() { rec route "$@"; [[ "$*" == *" get "* ]] && echo "    gateway: 10.0.0.1"; return 0; }
networksetup() {
  rec networksetup "$@"
  case $1 in
    -listnetworkserviceorder) printf '(1) Wi-Fi\\n(Hardware Port: Wi-Fi, Device: en0)\\n' ;;
    -getdnsservers) echo "There aren't any DNS Servers set on Wi-Fi." ;;
  esac
}
${body}
`], { encoding: 'utf8' })
  return { out: `${r.stdout}${r.stderr}`.trim(), code: r.status }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'awgud-'))
  for (const d of ['state', 'run']) spawnSync('mkdir', ['-p', join(dir, d)])
  writeFileSync(join(dir, 'amneziawg-go'), FAKE_DAEMON)
  chmodSync(join(dir, 'amneziawg-go'), 0o755)
  writeFileSync(join(dir, 'body'), 'set=1\nprivate_key=00\n\n')

  const up = sh(`cmd_up --id c418e2f7-9f53-4679-a506-5c31c59f56b6 --uid 501 --bin "$D/amneziawg-go" --body "$D/body" \\
    --endpoint-ip 2.27.175.125 --address 10.9.0.6/32 --allowed 0.0.0.0/0,::/0 --mtu 1376 --dns 1.1.1.1,1.0.0.1`)
  upOut = up.out
  if (up.code !== 0) throw new Error(`cmd_up failed (${up.code}): ${up.out}`)
  stateAfterUp = readFileSync(join(dir, 'state/state.env'), 'utf8')
  uapi = readFileSync(join(dir, 'run/received.txt'), 'utf8')
  calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean)
})

afterAll(() => {
  spawnSync('/usr/bin/pkill', ['-f', join(dir, 'amneziawg-go')])
  rmSync(dir, { recursive: true, force: true })
})

describe('cmd_up (stubbed, unprivileged)', () => {
  it('finishes and reports the interface', () => expect(upOut).toMatch(/IFACE=utun99$/))

  it('hands the config to the daemon and deletes the key file', () => {
    expect(uapi).toBe('set=1\nprivate_key=00\n\n')
    expect(existsSync(join(dir, 'body'))).toBe(false)
  })

  it('pins the endpoint to a clean gateway (regression: "10.0.0.1 en0")', () => {
    expect(calls).toContain('route -q -n add -inet -host 2.27.175.125 10.0.0.1')
  })

  it('configures the interface, full-tunnel routes and DNS', () => {
    expect(calls).toEqual(
      expect.arrayContaining([
        'chown 501 ' + join(dir, 'run/utun99.sock'),
        'ifconfig utun99 inet 10.9.0.6/32 10.9.0.6 alias',
        'ifconfig utun99 mtu 1376 up',
        'route -q -n add -inet 0.0.0.0/1 -interface utun99',
        'route -q -n add -inet 128.0.0.0/1 -interface utun99',
        'networksetup -setdnsservers Wi-Fi 1.1.1.1 1.0.0.1'
      ])
    )
  })

  it('does not capture packets unless diagnostics were requested', () => {
    expect(existsSync(join(dir, 'state/capture-inner.txt'))).toBe(false)
    expect(existsSync(join(dir, 'state/snapshot.txt'))).toBe(false)
  })

  it('records everything teardown needs', () => {
    for (const line of ['IFACE=utun99', 'EP_IP=2.27.175.125', 'EP_ROUTE=1', 'DNS_SERVICE=Wi-Fi', 'DNS_OLD=Empty']) {
      expect(stateAfterUp).toContain(line)
    }
    expect(stateAfterUp).toMatch(/^PID=\d+$/m)
    expect(stateAfterUp).toMatch(/^MONITOR_PID=\d+$/m)
  })
})

describe('cmd_up --replace (server switch)', () => {
  // The fake daemon runs as "Python", so accept any live PID (real is_daemon also checks the name).
  const liveDaemon = 'is_daemon() { [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; }'
  const upArgs = (ip: string) => `--id 5f0c3c2e-1111-4222-8333-944455556666 --uid 501 --bin "$D/amneziawg-go" --body "$D/body" \\
    --endpoint-ip ${ip} --address 10.9.0.46/32 --allowed 0.0.0.0/0,::/0 --mtu 1376 --dns 1.1.1.1`

  it('refuses to start over a running tunnel without it', () => {
    writeFileSync(join(dir, 'body'), 'set=1\nprivate_key=00\n\n')
    const r = sh(`${liveDaemon}; cmd_up ${upArgs('130.17.24.128')}`)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('Туннель уже активен')
    expect(readFileSync(join(dir, 'state/state.env'), 'utf8')).toBe(stateAfterUp) // untouched
  })

  it('stops the running tunnel and brings up the new one in the same call', () => {
    const oldPid = /^PID=(\d+)$/m.exec(stateAfterUp)![1]
    writeFileSync(join(dir, 'body'), 'set=1\nprivate_key=00\n\n')
    const r = sh(`${liveDaemon}; : > "$D/calls"; cmd_up ${upArgs('130.17.24.128')} --replace 1
      kill -0 ${oldPid} 2>/dev/null && echo old-alive || echo old-gone`)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/IFACE=utun99\nold-gone$/)
    const switchCalls = readFileSync(join(dir, 'calls'), 'utf8')
    expect(switchCalls).toContain('route -q -n delete -inet -host 2.27.175.125') // old endpoint route
    expect(switchCalls).toContain('route -q -n add -inet -host 130.17.24.128 10.0.0.1') // new one
    // The old DNS is restored before the new tunnel reads it, so «before VPN» stays the real original.
    expect(switchCalls.indexOf('networksetup -setdnsservers Wi-Fi Empty')).toBeLessThan(
      switchCalls.indexOf('networksetup -setdnsservers Wi-Fi 1.1.1.1')
    )
    stateAfterUp = readFileSync(join(dir, 'state/state.env'), 'utf8')
    expect(stateAfterUp).toContain('EP_IP=130.17.24.128')
    expect(stateAfterUp).not.toMatch(new RegExp(`^PID=${oldPid}$`, 'm'))
  })
})

describe('cmd_down (stubbed, unprivileged)', () => {
  it('restores DNS, removes the endpoint route, stops daemon and monitor, clears state', () => {
    const pid = /^PID=(\d+)$/m.exec(stateAfterUp)![1]
    const monitor = /^MONITOR_PID=(\d+)$/m.exec(stateAfterUp)![1]
    // The fake daemon runs as "Python", so accept any live PID here (real is_daemon also checks the name).
    const r = sh(`is_daemon() { [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; }; : > "$D/calls"; cmd_down; sleep 0.5
      kill -0 ${pid} 2>/dev/null && echo daemon-alive || echo daemon-gone
      kill -0 ${monitor} 2>/dev/null && echo monitor-alive || echo monitor-gone`)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Туннель остановлен\ndaemon-gone\nmonitor-gone$/)
    const down = readFileSync(join(dir, 'calls'), 'utf8')
    expect(down).toContain('networksetup -setdnsservers Wi-Fi Empty')
    expect(down).toContain('route -q -n delete -inet -host 130.17.24.128') // the tunnel it switched to
    expect(existsSync(join(dir, 'state/state.env'))).toBe(false)
  })
})

/**
 * The invariant the whole design rests on: no tunnel outlives the application that asked for it.
 * Nothing unprivileged can hold it — quitting can be a crash or a Force Quit — so the root monitor
 * started by `up` watches the application's pid and tears the tunnel down itself.
 */
describe('monitor_loop watching the application', () => {
  // `exec route -n monitor` inside the process substitution skips shell functions and takes this
  // instead, so the monitor has something that stays open to wait on, as the real one does.
  const fakeRoute = (): string => {
    const bin = join(dir, 'bin')
    spawnSync('mkdir', ['-p', bin])
    writeFileSync(join(bin, 'route'), '#!/bin/sh\nexec sleep 20\n')
    chmodSync(join(bin, 'route'), 0o755)
    return bin
  }

  const watch = (killApp: boolean, waitTicks: number): { out: string; code: number | null } => {
    fakeRoute()
    return sh(`
      PATH="$D/bin:$PATH"
      is_daemon() { [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; }
      /bin/sleep 20 & APP=$!
      /bin/sleep 20 & DAEMON=$!
      PID=$DAEMON; APP_PID=$APP; APP_CMD=sleep
      IFACE=utun99; EP_IP=2.27.175.125; EP_ROUTE=1; DNS_SERVICE=Wi-Fi; DNS_OLD=Empty
      save_state
      : > "$D/calls"
      monitor_loop >/dev/null 2>&1 &
      disown $! 2>/dev/null || true
      sleep 0.5
      ${killApp ? 'kill $APP 2>/dev/null || true' : ''}
      for _ in $(seq 1 ${waitTicks}); do [[ -f "$STATE_FILE" ]] || break; sleep 0.25; done
      [[ -f "$STATE_FILE" ]] && echo state-kept || echo state-gone
      kill -0 $DAEMON 2>/dev/null && echo daemon-alive || echo daemon-gone
      kill $APP $DAEMON 2>/dev/null || true
    `)
  }

  it('knows the application by number and by name', () => {
    const r = sh(`
      ask() { APP_PID=$1 APP_CMD=$2; is_app && echo yes || echo no; }
      ask $$ bash
      ask 2147483646 bash
      ask $$ definitely-not-the-app
      ask "" ""
    `)
    // Alive; gone; alive but a different process took the number; nobody being watched at all.
    expect(r.out.split('\n')).toEqual(['yes', 'no', 'no', 'yes'])
  })

  it('takes the tunnel down when the application is gone', () => {
    const r = watch(true, 24)
    expect(r.out).toContain('state-gone')
    expect(r.out).toContain('daemon-gone')
    // Not just the daemon: the network is put back the way it was.
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toContain('networksetup -setdnsservers Wi-Fi Empty')
  }, 15_000)

  it('leaves a running tunnel alone while the application is alive', () => {
    const r = watch(false, 12)
    expect(r.out).toContain('state-kept')
    expect(r.out).toContain('daemon-alive')
  }, 15_000)
})
