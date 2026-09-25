import { execFile, spawn } from 'node:child_process'
import { userInfo } from 'node:os'

/** pkexec's own exit codes (its manual page): the user dismissed the authentication prompt. */
export const PKEXEC_CANCELLED = 126
/** pkexec's own: authentication failed, or polkit said no. */
export const PKEXEC_NOT_AUTHORIZED = 127

/** What the password field says: whose password, and whether the last one was wrong. */
export interface PasswordRequest {
  /** «Ivan (ivan)», as polkit names the identity it authenticates; empty when it did not say. */
  user: string
  retry: boolean
}

/** Resolves with the password typed, or null for «Отмена». */
export type AskPassword = (request: PasswordRequest) => Promise<string | null>

/**
 * Runs exe with administrator rights via pkexec, gated by the polkit action helper/setup_linux.go
 * installs (`ru.senawg.helper.setup` / `ru.senawg.helper.remove`, both `auth_admin`). The Linux
 * counterpart of ./elevate.ts's runElevated (PowerShell's Start-Process -Verb RunAs).
 *
 * The password is asked by the desktop's polkit agent, and that is always tried first. A bare window
 * manager (Hyprland, sway, i3…) often runs none, and then pkexec falls back to asking on its terminal —
 * which an application started from a menu does not have («Error creating textual authentication
 * agent»); nothing has run by then. Only in that case, and only with `ask`, pkexec is run again on a
 * terminal of its own (a pseudo-terminal from util-linux's `script`), and its question is put to the
 * person by `ask`, in SenAWG's own window.
 */
export async function runElevatedLinux(
  exe: string,
  args: readonly string[],
  ask?: AskPassword
): Promise<{ code: number; stderr: string }> {
  const first = await new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile('pkexec', [exe, ...args], (err, _stdout, stderr) => {
      if (!err) return resolve({ code: 0, stderr: '' })
      resolve({ code: typeof err.code === 'number' ? err.code : 1, stderr: stderr.trim() })
    })
  })
  if (first.code === 0 || !NO_AGENT.test(first.stderr)) return first
  if (!ask || !(await hasScript())) return { code: first.code, stderr: NO_AGENT_TEXT }

  let retry = false
  for (;;) {
    const run = await pkexecOnTerminal(exe, args, ask, retry)
    // A wrong password ends pkexec's own attempt; the person is asked again, the command run anew.
    if (run.code === PKEXEC_NOT_AUTHORIZED && run.authFailed) {
      retry = true
      continue
    }
    return { code: run.code, stderr: run.stderr }
  }
}

/** pkexec found no polkit agent and could not ask on a terminal either. */
const NO_AGENT = /textual authentication agent|No authentication agent/i
const NO_AGENT_TEXT =
  'Не у кого спросить пароль администратора: в системе не запущен агент polkit (например, polkit-gnome или lxpolkit). Запустите его или установите SenAWG из терминала.'

let scriptCheck: Promise<boolean> | null = null

/** util-linux's `script`: busybox has one too, but without -e, and its exit code would not be pkexec's. */
function hasScript(): Promise<boolean> {
  scriptCheck ??= new Promise((resolve) => {
    execFile('script', ['--version'], (err, stdout) => resolve(!err && /util-linux/.test(stdout)))
  })
  return scriptCheck
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

/** The lines polkit's text agent prints around its question; everything else is the command's own output. */
const AGENT_LINE = /^(==== AUTHENTICAT|Authentication is needed|Multiple identities|Choose identity|Authenticating as:|polkit-agent-helper|Password:|\s*\d+\.\s+.*\(.+\)\s*$)/

/**
 * One pkexec run on a pseudo-terminal. The agent's words are read in the C locale, so they are the same
 * everywhere: «==== AUTHENTICATING FOR …», maybe a list of identities to choose from, «Authenticating as:
 * …», then PAM's own prompt («Password: »). The password goes back on the terminal, which the agent has
 * switched to no echo, so it never comes out again — and is scrubbed from the output all the same.
 */
function pkexecOnTerminal(
  exe: string,
  args: readonly string[],
  ask: AskPassword,
  retry: boolean
): Promise<{ code: number; stderr: string; authFailed: boolean }> {
  return new Promise((resolve) => {
    const command = ['pkexec', exe, ...args].map(quote).join(' ')
    const child = spawn('script', ['-qefc', command, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: '', SHELL: '/bin/sh' }
    })
    let out = ''
    let seen = 0
    let authenticating = false
    let asking = false
    let cancelled = false
    let authFailed = false
    let user = ''
    const secrets: string[] = []

    const onOutput = (chunk: Buffer): void => {
      out += chunk.toString('utf8').replace(ANSI, '').replace(/\r/g, '')
      const fresh = out.slice(seen)
      if (/==== AUTHENTICATING FOR/.test(fresh)) authenticating = true
      if (/AUTHENTICATION FAILED/.test(fresh)) authFailed = true
      const who = /Authenticating as: (.+)\n/.exec(fresh)
      if (who) user = who[1].trim()
      if (!authenticating || asking) return
      // A question is answered once: the same unfinished line, grown by another chunk, is not a new one.
      const start = out.lastIndexOf('\n') + 1
      if (start < seen) return
      const pending = out.slice(start)
      const choose = /\(1-(\d+)\):\s*$/.exec(pending)
      if (choose) {
        seen = out.length
        child.stdin.write(`${identityIndex(out)}\n`)
        return
      }
      // PAM's prompt ends in a colon; the agent's own lines may too, when a chunk happens to end there.
      if (!/:\s*$/.test(pending) || /^(Authenticating as|====|Authentication is needed|Multiple identities)/.test(pending)) return
      seen = out.length
      asking = true
      void ask({ user, retry: retry || authFailed }).then((password) => {
        asking = false
        if (password === null) {
          cancelled = true
          child.kill('SIGTERM')
          return
        }
        secrets.push(password)
        child.stdin.write(`${password}\n`)
      })
    }
    child.stdout.on('data', onOutput)
    child.stderr.on('data', onOutput)
    child.on('error', (err) => resolve({ code: 1, stderr: err.message, authFailed: false }))
    child.on('close', (code) => {
      if (cancelled) return resolve({ code: PKEXEC_CANCELLED, stderr: '', authFailed: false })
      let text = out
      for (const s of secrets) if (s) text = text.split(s).join('')
      const stderr = text
        .split('\n')
        .filter((l) => l.trim() && !AGENT_LINE.test(l))
        .join('\n')
        .trim()
      resolve({ code: code ?? 1, stderr: NO_AGENT.test(stderr) ? NO_AGENT_TEXT : stderr, authFailed })
    })
  })
}

/** Among the identities polkit offers («  2.  Ivan (ivan)»), the one this person is logged in as, or the first. */
function identityIndex(out: string): number {
  const me = userInfo().username
  for (const m of out.matchAll(/^\s*(\d+)\.\s+.*\(([^()]+)\)\s*$/gm)) {
    if (m[2] === me) return Number(m[1])
  }
  return 1
}
