export interface HelperOutput {
  /** Non-fatal `warning:` lines the script printed. */
  warnings: string[]
  /** Everything else, joined — the error message when the script failed. */
  rest: string
}

/**
 * osascript merges the script's stderr into the result (we append 2>&1) and converts \n to \r.
 * Split it back into warnings and the actual message. `IFACE=` is a machine line, not for humans.
 */
export function splitHelperOutput(text: string): HelperOutput {
  const warnings: string[] = []
  const rest: string[] = []
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('IFACE=')) continue
    const w = /^warning:\s*(.*)$/.exec(line)
    if (w) warnings.push(w[1])
    else rest.push(line)
  }
  return { warnings, rest: rest.join('\n') }
}
