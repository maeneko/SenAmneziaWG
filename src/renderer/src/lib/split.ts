import type { UiSettings } from '@shared/uiSettings'
import { pluralSites } from './format'

type SplitFields = Pick<UiSettings, 'splitMode' | 'splitInclude' | 'splitExclude'>

/** What is in force, in a few words: the main screen's chip. `on`: a list is actually applied. */
export function splitSummary(s: SplitFields): { text: string; on: boolean } {
  if (s.splitMode === 'off') return { text: 'Всё через VPN', on: false }
  const n = (s.splitMode === 'include' ? s.splitInclude : s.splitExclude).length
  if (n === 0) return { text: 'Список пуст — всё через VPN', on: false }
  return { text: `${s.splitMode === 'include' ? 'Только' : 'Кроме'} ${pluralSites(n)}`, on: true }
}

/** The part of the settings that changes what the helper does; a change of it needs a new connection to show. */
export const splitKey = (s: SplitFields): string => JSON.stringify([s.splitMode, s.splitInclude, s.splitExclude])
