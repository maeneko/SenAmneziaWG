import type { AppNotice } from '@shared/types'

const RANK: Record<AppNotice['priority'], number> = { high: 0, normal: 1, low: 2 }

/** Priority first, then the newest; of two sent in the same millisecond, the one that came later. */
export function orderNotices(notices: AppNotice[]): AppNotice[] {
  return [...notices].reverse().sort((a, b) => RANK[a.priority] - RANK[b.priority] || b.at - a.at)
}
