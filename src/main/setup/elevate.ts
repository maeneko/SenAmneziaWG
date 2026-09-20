import { execFile } from 'node:child_process'

/** ERROR_CANCELLED: the user pressed «Нет» in the UAC prompt. Not a failure — nothing was touched. */
export const ERROR_CANCELLED = 1223

/**
 * One argument the way CommandLineToArgvW reads it back: quoted, with backslashes doubled only where
 * they sit in front of a quote (Windows paths end in backslashes and contain spaces all the time).
 */
export function quoteWinArg(arg: string): string {
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

const psQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`

/**
 * The PowerShell that runs `exe` behind the UAC prompt and comes back with its exit code. Start-Process
 * -Verb RunAs is how an unelevated process asks for a consent prompt; -Wait is what lets us know when it
 * ended. Declining the prompt is reported as ERROR_CANCELLED, every other failure as 1 with its text on stderr.
 */
export function elevationScript(exe: string, args: readonly string[]): string {
  const argumentList = args.map(quoteWinArg).join(' ')
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${psQuote(argumentList)} -Verb RunAs -PassThru -Wait -WindowStyle Hidden`,
    '  exit $p.ExitCode',
    '} catch {',
    `  if ($_.Exception.NativeErrorCode -eq ${ERROR_CANCELLED}) { exit ${ERROR_CANCELLED} }`,
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\n')
}

export interface ElevatedResult {
  code: number
  stderr: string
}

/** Runs exe with administrator rights; resolves with its exit code once it has finished. */
export function runElevated(exe: string, args: readonly string[]): Promise<ElevatedResult> {
  const encoded = Buffer.from(elevationScript(exe, args), 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ code: 0, stderr: '' })
        const code = typeof err.code === 'number' ? err.code : 1
        resolve({ code, stderr: stderr.trim() })
      }
    )
  })
}
