import { useCallback, useEffect, useState } from 'react'
import type { LogEntry } from '@shared/types'
import { mergeLogs } from '../lib/logs'

/** Lives at the app root so the journal keeps collecting while another tab is open. */
export function useLogs(): { entries: LogEntry[]; clear: () => Promise<void> } {
  const [entries, setEntries] = useState<LogEntry[]>([])

  useEffect(() => {
    const off = window.awg.onLogs((batch) => setEntries((prev) => mergeLogs(prev, batch)))
    void window.awg.getLogs().then((initial) => setEntries((prev) => mergeLogs(prev, initial)))
    return off
  }, [])

  const clear = useCallback(async () => {
    await window.awg.clearLogs()
    setEntries([])
  }, [])

  return { entries, clear }
}
