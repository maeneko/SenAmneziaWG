import { execFile } from 'node:child_process'

/** pkexec's own exit codes (its manual page): the user dismissed the authentication prompt. */
export const PKEXEC_CANCELLED = 126

/**
 * Runs exe with administrator rights via pkexec, gated by the polkit action helper/setup_linux.go
 * installs (`ru.senawg.helper.setup` / `ru.senawg.helper.remove`, both `auth_admin`). The Linux
 * counterpart of ./elevate.ts's runElevated (PowerShell's Start-Process -Verb RunAs).
 */
export function runElevatedLinux(exe: string, args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile('pkexec', [exe, ...args], (err, _stdout, stderr) => {
      if (!err) return resolve({ code: 0, stderr: '' })
      const code = typeof err.code === 'number' ? err.code : 1
      resolve({ code, stderr: stderr.trim() })
    })
  })
}
