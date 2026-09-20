  import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve('resources/scripts/awg.sh')

/**
 * Runs awg.sh functions with `route` and `netstat` replaced by shell functions (functions win over
 * PATH), so the re-pinning logic is testable without root or touching the real routing table.
 * The fake `route` keeps one host route in a file and records every add/delete.
 */
let dir: string
const netstat = (v4: string, v6 = ''): void => {
  writeFileSync(join(dir, 'netstat.inet'), v4)
  writeFileSync(join(dir, 'netstat.inet6'), v6)
}
const calls = (): string[] => readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean)

function run(body: string): { out: string; code: number | null } {
  const driver = `
set -euo pipefail
D=${JSON.stringify(dir)}
AWG_SH_LIB=1 source ${JSON.stringify(SCRIPT)}
: > "$D/calls"
netstat() { cat "$D/netstat.\${3}"; }
route() {
  local args="$*"
  case "$args" in
    *" get "*) [[ -s "$D/route" ]] && echo "    gateway: $(cat "$D/route")"; return 0 ;;
    *" delete "*) echo "delete" >> "$D/calls"; : > "$D/route" ;;
    *" add "*) echo "add \${args#*-host }" >> "$D/calls"; set -- $args; echo "\${@: -1}" | grep -q blackhole && echo "\${@: -2:1}" > "$D/route" || echo "\${@: -1}" > "$D/route" ;;
  esac
}
${body}
`
  const r = spawnSync('/bin/bash', ['-c', driver], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`)
  return { out: r.stdout.trim(), code: r.status }
}

const WIFI = 'Routing tables\n\nInternet:\nDestination Gateway Flags Netif Expire\ndefault link#20 UCSg utun4\ndefault 10.0.0.1 UGScIg en0\n'
const PHONE = 'Internet:\ndefault 172.20.10.1 UGScIg en5\n'
const OFFLINE = 'Internet:\ndefault link#20 UCSg utun4\n'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awgsh-'))
  writeFileSync(join(dir, 'route'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('physical_default', () => {
  it('skips link# (VPN) routes and macOS utun routes', () => {
    netstat(WIFI, 'default fe80::%utun0 UGcIg utun0\ndefault fe80::1%en0 UGc en0\n')
    expect(run('physical_default inet; physical_default inet6').out).toBe('10.0.0.1 en0\nfe80::1%en0 en0')
  })
  it('is empty when only tunnels have a default route', () => {
    netstat(OFFLINE, 'default fe80::%utun0 UGcIg utun0\n')
    expect(run('echo "[$(physical_default inet)][$(physical_default inet6)]"').out).toBe('[][]')
  })
})

describe('pin_endpoint', () => {
  const EP = 'EP_IP=203.0.113.7;'

  it('pins the endpoint to the physical gateway', () => {
    netstat(WIFI)
    run(`${EP} pin_endpoint force`)
    expect(calls()).toEqual(['delete', 'add 203.0.113.7 10.0.0.1'])
  })

  it('does nothing when the route already matches (so its own RTM events cannot loop)', () => {
    netstat(WIFI)
    run(`${EP} pin_endpoint force; : > "$D/calls"; pin_endpoint; pin_endpoint`)
    expect(calls()).toEqual([])
  })

  it('follows a network switch (Wi-Fi → phone hotspot)', () => {
    netstat(WIFI)
    writeFileSync(join(dir, 'phone'), PHONE)
    run(`${EP} pin_endpoint force; : > "$D/calls"; cp "$D/phone" "$D/netstat.inet"; pin_endpoint`)
    expect(calls()).toEqual(['delete', 'add 203.0.113.7 172.20.10.1'])
  })

  it('re-adds a route the kernel dropped', () => {
    netstat(WIFI)
    run(`${EP} pin_endpoint force; : > "$D/route"; : > "$D/calls"; pin_endpoint`)
    expect(calls()).toEqual(['delete', 'add 203.0.113.7 10.0.0.1'])
  })

  it('rebuilds an identical-looking route when forced (stale interface after wake)', () => {
    netstat(WIFI)
    run(`${EP} pin_endpoint force; : > "$D/calls"; pin_endpoint force`)
    expect(calls()).toEqual(['delete', 'add 203.0.113.7 10.0.0.1'])
  })

  it('blackholes the endpoint while offline instead of letting it loop into the tunnel', () => {
    netstat(OFFLINE)
    run(`${EP} pin_endpoint`)
    expect(calls()).toEqual(['delete', 'add 203.0.113.7 127.0.0.1 -blackhole'])
  })

  it('stays quiet while offline, then restores the real route when the network returns', () => {
    netstat(OFFLINE)
    writeFileSync(join(dir, 'wifi'), WIFI)
    const { out } = run(
      `${EP} pin_endpoint; : > "$D/calls"; pin_endpoint; pin_endpoint; echo quiet=$(wc -l < "$D/calls" | tr -d ' '); cp "$D/wifi" "$D/netstat.inet"; pin_endpoint`
    )
    expect(out).toBe('quiet=0')
    expect(calls()).toEqual(['delete', 'add 203.0.113.7 10.0.0.1'])
  })

  it('uses ::1 for an IPv6 endpoint blackhole', () => {
    netstat(OFFLINE, '')
    run('EP_IP=2001:db8::7; pin_endpoint')
    expect(calls()).toEqual(['delete', 'add 2001:db8::7 ::1 -blackhole'])
  })
})

describe('is_monitor', () => {
  it('only matches our own awg.sh process, never an unrelated PID', async () => {
    const other = spawn('/bin/sleep', ['5'])
    const ours = spawn('/bin/bash', ['-c', 'exec -a awg.sh /bin/sleep 5'])
    await new Promise((r) => setTimeout(r, 200))
    const out = run(`is_monitor ${ours.pid} && echo ours; is_monitor ${other.pid} || echo other-rejected; is_monitor "" || echo empty-rejected`).out
    other.kill()
    ours.kill()
    expect(out).toBe('ours\nother-rejected\nempty-rejected')
  })
})

describe('kill_monitor', () => {
  it('kills a monitor that ignores SIGTERM (as launched through the macOS admin prompt)', async () => {
    const stubborn = spawn('/usr/bin/perl', ['-e', '$SIG{TERM}="IGNORE"; exec {"/bin/bash"} "awg.sh", "-c", "sleep 30; :"'])
    const exited = new Promise<NodeJS.Signals | null>((r) => stubborn.once('exit', (_code, signal) => r(signal)))
    await new Promise((r) => setTimeout(r, 300))
    expect(run(`kill ${stubborn.pid} 2>/dev/null; sleep 0.3; kill -0 ${stubborn.pid} && echo survived-term`).out).toBe('survived-term')
    run(`kill_monitor ${stubborn.pid}`)
    // Resolves only once the process is really gone (a zombie would still answer kill -0).
    const signal = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))])
    expect(signal).not.toBe('timeout')
  })
})

describe('runs under the script\'s own set -euo pipefail', () => {
  // Regression: reap_orphan_monitors silently aborted `up` before the daemon started.
  it('reap_orphan_monitors does not abort the script', () => {
    expect(run('reap_orphan_monitors; echo survived').out).toBe('survived')
  })
  it('physical_default and pin_endpoint do not abort it', () => {
    netstat(WIFI)
    expect(run('physical_default inet >/dev/null; EP_IP=203.0.113.7; pin_endpoint; pin_endpoint; echo survived').out).toBe('survived')
  })
  it('kill_monitor and teardown with empty state do not abort it', () => {
    expect(run('kill_monitor ""; networksetup() { :; }; teardown; echo survived').out).toBe('survived')
  })
})
