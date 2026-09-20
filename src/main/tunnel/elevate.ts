import { execFile } from 'node:child_process'
import { UserCancelledError } from './TunnelController'

/** osascript returns \r for every line break. */
const normalise = (s: string): string => s.replace(/\r\n?/g, '\n').trim()
const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`
const asQuote = (s: string): string => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

/** Runs argv as root behind the standard macOS admin prompt. Resolves with stdout. */
export function runElevated(argv: string[], prompt: string): Promise<string> {
  // 2>&1: `do shell script` drops stderr on success, and the script's warnings belong in the log.
  const command = `${argv.map(shQuote).join(' ')} 2>&1`
  const script = `do shell script ${asQuote(command)} with prompt ${asQuote(prompt)} with administrator privileges`
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120_000 }, (err, stdout, stderr) => {
      if (!err) return resolve(normalise(stdout))
      const text = normalise(stderr)
      if (/User canceled|\(-128\)/i.test(text)) return reject(new UserCancelledError())
      // osascript wraps failures as "<pos>: execution error: <message> (<code>)".
      const message = text.replace(/^.*?execution error:\s*/s, '').replace(/\s*\(-?\d+\)\s*$/, '')
      reject(new Error(message || 'Не удалось выполнить действие с правами администратора'))
    })
  })
}
