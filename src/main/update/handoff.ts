import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The seamless update is two processes: the running application, and the installer it started (which
 * prepares the new version beside the old one). They cannot share a pipe — the installer's window may be
 * open before the application has gone — so they talk through marker files in a folder the application made
 * (setup/mode.ts: `--handoff=`). Each marker is written once, by the installer:
 *
 *   shown      its window is up over the application's: the application may close now
 *   cancelled  the administrator prompt was declined, nothing was touched
 *   failed     it broke before anything was replaced (the file holds why)
 */
export type Marker = 'shown' | 'cancelled' | 'failed'

/** The installer must answer within this — enough for a slow download folder and a slow copy, not forever. */
export const HANDOFF_TIMEOUT_MS = 5 * 60_000

export type HandoffResult = { kind: 'shown' } | { kind: 'cancelled' } | { kind: 'failed'; message: string } | { kind: 'timeout' }

const file = (dir: string, marker: Marker): string => join(dir, marker)

export function writeMarker(dir: string, marker: Marker, text = ''): void {
  writeFileSync(file(dir, marker), text)
}

/** What the installer has said so far; null while it has said nothing. */
export function readMarker(dir: string): HandoffResult | null {
  if (existsSync(file(dir, 'shown'))) return { kind: 'shown' }
  if (existsSync(file(dir, 'cancelled'))) return { kind: 'cancelled' }
  if (existsSync(file(dir, 'failed'))) {
    let message = ''
    try {
      message = readFileSync(file(dir, 'failed'), 'utf8').trim()
    } catch {
      /* the marker without its text is still a failure */
    }
    return { kind: 'failed', message: message || 'Не удалось подготовить обновление' }
  }
  return null
}

/**
 * Waits for the installer's word. `alive` says whether it is still running: one that died without a marker
 * ends the wait at once instead of after the whole timeout.
 */
export async function waitForMarker(
  dir: string,
  { timeoutMs = HANDOFF_TIMEOUT_MS, stepMs = 100, alive = () => true }: { timeoutMs?: number; stepMs?: number; alive?: () => boolean } = {}
): Promise<HandoffResult> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const said = readMarker(dir)
    if (said) return said
    if (!alive()) {
      // It may have written its marker just before exiting.
      return readMarker(dir) ?? { kind: 'failed', message: 'Установщик закрылся, не начав обновление' }
    }
    if (Date.now() >= until) return { kind: 'timeout' }
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}
