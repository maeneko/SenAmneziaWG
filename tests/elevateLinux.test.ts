import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// pkexec and util-linux's script, played by hand: what each prints, and what comes back on the terminal.
type ExecResult = { code: number; stdout?: string; stderr?: string }
const cp = vi.hoisted(() => ({
  pkexec: [] as ExecResult[],
  script: { code: 0, stdout: 'script from util-linux 2.39.3\n' } as ExecResult,
  runs: [] as FakeTerminal[],
  onSpawn: (_t: FakeTerminal): void => undefined
}))

class FakeTerminal extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written: string[] = []
  killed = false
  stdin = { write: (s: string) => this.written.push(s) }
  kill(): void {
    this.killed = true
    setImmediate(() => this.emit('close', null))
  }
  say(text: string): void {
    this.stdout.emit('data', Buffer.from(text.replace(/\n/g, '\r\n')))
  }
  exit(code: number): void {
    setImmediate(() => this.emit('close', code))
  }
}

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, _args: string[], cb: (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void) => {
    const r = cmd === 'script' ? cp.script : (cp.pkexec.shift() ?? { code: 0 })
    const err = r.code ? Object.assign(new Error('failed'), { code: r.code }) : null
    setImmediate(() => cb(err, r.stdout ?? '', r.stderr ?? ''))
  },
  spawn: () => {
    const t = new FakeTerminal()
    cp.runs.push(t)
    setImmediate(() => cp.onSpawn(t))
    return t
  }
}))
vi.mock('node:os', () => ({ userInfo: () => ({ username: 'ivan' }) }))

const { runElevatedLinux, PKEXEC_CANCELLED } = await import('../src/main/setup/elevateLinux')

const NO_AGENT = "Error creating textual authentication agent: Error opening current controlling terminal for the process (`/dev/tty'): No such device or address"
const PROMPT = '==== AUTHENTICATING FOR org.freedesktop.policykit.exec ====\nAuthentication is needed to run `/tmp/awg-helper\' as the super user\nAuthenticating as: Ivan,,, (ivan)\nPassword: '

beforeEach(() => {
  cp.pkexec = []
  cp.runs = []
  cp.onSpawn = () => undefined
})

describe('runElevatedLinux', () => {
  it('leaves the asking to the desktop agent whenever there is one', async () => {
    const ask = vi.fn()
    cp.pkexec = [{ code: 0 }]
    expect(await runElevatedLinux('/h', ['setup'], ask)).toEqual({ code: 0, stderr: '' })
    cp.pkexec = [{ code: 126, stderr: '' }]
    expect(await runElevatedLinux('/h', ['setup'], ask)).toEqual({ code: 126, stderr: '' })
    expect(ask).not.toHaveBeenCalled()
    expect(cp.runs).toHaveLength(0)
  })

  it('says what is missing when no agent is running and nothing can ask instead', async () => {
    cp.pkexec = [{ code: 127, stderr: NO_AGENT }]
    const { code, stderr } = await runElevatedLinux('/h', ['remove'])
    expect(code).toBe(127)
    expect(stderr).toMatch(/агент polkit/)
  })

  it('asks in its own window when there is no agent, and runs the command on a terminal of its own', async () => {
    cp.pkexec = [{ code: 127, stderr: NO_AGENT }]
    cp.onSpawn = (t) => t.say(PROMPT)
    const ask = vi.fn(async () => 's3cret')
    const done = runElevatedLinux('/h', ['setup', '--app-to', "/opt/it's"], ask)
    await vi.waitFor(() => expect(cp.runs[0]?.written).toEqual(['s3cret\n']))
    cp.runs[0].say('\n==== AUTHENTICATION COMPLETE ====\nsomething the helper said\n')
    cp.runs[0].exit(0)
    expect(await done).toEqual({ code: 0, stderr: 'something the helper said' })
    expect(ask).toHaveBeenCalledExactlyOnceWith({ user: 'Ivan,,, (ivan)', retry: false })
  })

  it('asks again after a wrong password, saying so', async () => {
    cp.pkexec = [{ code: 127, stderr: NO_AGENT }]
    cp.onSpawn = (t) => t.say(PROMPT)
    const ask = vi.fn(async () => 'pw')
    const done = runElevatedLinux('/h', ['setup'], ask)
    await vi.waitFor(() => expect(cp.runs[0]?.written).toHaveLength(1))
    cp.runs[0].say('\npolkit-agent-helper-1: pam_authenticate failed: Authentication failure\n==== AUTHENTICATION FAILED ====\nError executing command as another user: Not authorized\n')
    cp.runs[0].exit(127)
    await vi.waitFor(() => expect(cp.runs[1]?.written).toHaveLength(1))
    cp.runs[1].exit(0)
    expect((await done).code).toBe(0)
    expect(ask.mock.calls.map((c) => (c as unknown as [{ retry: boolean }])[0].retry)).toEqual([false, true])
  })

  it('stops at «Отмена» as a declined prompt', async () => {
    cp.pkexec = [{ code: 127, stderr: NO_AGENT }]
    cp.onSpawn = (t) => t.say(PROMPT)
    const result = await runElevatedLinux('/h', ['setup'], async () => null)
    expect(result.code).toBe(PKEXEC_CANCELLED)
    expect(cp.runs[0].killed).toBe(true)
  })

  it('picks this user among the identities polkit offers', async () => {
    cp.pkexec = [{ code: 127, stderr: NO_AGENT }]
    cp.onSpawn = (t) =>
      t.say('==== AUTHENTICATING FOR x ====\nMultiple identities can be used for authentication:\n 1.  root\n 2.  Anna (anna)\n 3.  Ivan (ivan)\nChoose identity to authenticate as (1-3): ')
    const done = runElevatedLinux('/h', ['setup'], async () => 'pw')
    await vi.waitFor(() => expect(cp.runs[0]?.written).toEqual(['3\n']))
    cp.runs[0].say('3\nAuthenticating as: Ivan (ivan)\nPassword: ')
    await vi.waitFor(() => expect(cp.runs[0].written).toEqual(['3\n', 'pw\n']))
    cp.runs[0].exit(0)
    expect((await done).code).toBe(0)
  })
})
