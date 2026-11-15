import type { AppNotice, RevealView, UpdateState } from '../shared/types'

/** One message for the operating system: what to say, and where a click should bring the window. */
export interface SystemNotice {
  /** A notice's id, or `update-<version>`: remembered so the same thing is said once. */
  id: string
  title: string
  body: string
  view: RevealView
}

/**
 * What deserves the operating system's own notification: the subscription the VPN depends on (`high`),
 * and only what it has not said yet. Announcements and confirmations stay on the main screen.
 */
export function importantNotices(notices: readonly AppNotice[], shown: readonly string[]): SystemNotice[] {
  const seen = new Set(shown)
  return notices
    .filter((n) => n.priority === 'high' && !seen.has(n.id))
    .map((n) => ({
      id: n.id,
      title: n.title,
      // A notification with nothing under the title reads as cut off; the section has the details.
      body: n.text ?? 'Откройте SenAWG, чтобы узнать подробности.',
      view: n.action?.view ?? 'tunnels'
    }))
}

/**
 * A new version, said once per version: `available` with «Обновлять автоматически» off, `ready` with it
 * on — the first moment there is something to do. A later version is a new message.
 */
export function updateNotice(state: UpdateState, shown: string | null): { version: string; notice: SystemNotice } | null {
  if (state.kind !== 'available' && state.kind !== 'ready') return null
  if (state.version === shown) return null
  return {
    version: state.version,
    notice: {
      id: `update-${state.version}`,
      title: `Доступна новая версия SenAWG ${state.version}`,
      body:
        state.kind === 'ready'
          ? 'Уже загружена и проверена. Откройте «Настройки → Обновления», чтобы установить.'
          : 'Откройте «Настройки → Обновления», чтобы скачать и установить.',
      view: 'settings'
    }
  }
}
