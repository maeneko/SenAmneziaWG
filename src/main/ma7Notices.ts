import type { AppNotice } from '../shared/types'
import type { Ma7Notice } from './ma7'

/** First look as the application starts, then every five minutes; the «Обновить» button in the panel asks at once. */
export const FIRST_MS = 0
export const EVERY_MS = 5 * 60_000
/** A window brought to the front checks again, but not more often than this. */
export const FOCUS_MS = 2 * 60_000

/** These lead to «Профиль»: the subscription itself, not news about the service. `topup_rejected`: «Пополнить» in «Устройства». */
const PROFILE_KINDS = ['ending', 'overdue', 'payment_ok', 'payment_rejected', 'topup_rejected']

const idOf = (login: string, noticeId: string): string => `ma7-${login}-${noticeId}`

/** The notices of every account as the main screen shows them. A login in the id keeps two accounts apart. */
export function toAppNotices(cache: ReadonlyMap<string, readonly Ma7Notice[]>): AppNotice[] {
  const out: AppNotice[] = []
  for (const [login, list] of cache) {
    for (const n of list) {
      out.push({
        id: idOf(login, n.id),
        tone: n.tone,
        priority: n.priority,
        title: n.title,
        ...(n.text ? { text: n.text } : {}),
        ...(PROFILE_KINDS.includes(n.kind) ? { action: { label: 'Профиль', view: 'profile' as const } } : {}),
        dismissible: true,
        at: n.at
      })
    }
  }
  return out
}

/**
 * What of the closed ones can go from settings.json: the notices of `login` that MA7 no longer sends (deleted,
 * expired, an ended subscription period). Called only with a fresh answer — a failed one proves nothing.
 */
export function forgotten(dismissed: readonly string[], login: string, fresh: readonly Ma7Notice[]): string[] {
  const prefix = `ma7-${login}-`
  const live = new Set(fresh.map((n) => idOf(login, n.id)))
  return dismissed.filter((id) => id.startsWith(prefix) && !live.has(id))
}

export interface Ma7NoticesHost {
  accounts(): string[]
  fetch(login: string): Promise<Ma7Notice[]>
  dismissed(): string[]
  forget(ids: string[]): void
  /** The list changed: push it to the window. */
  changed(): void
  log(level: 'info' | 'warn', message: string): void
  now?(): number
}

/** Keeps what MA7's notice center said, per account. Nothing is stored: a restart asks again. */
export class Ma7Notices {
  private readonly cache = new Map<string, Ma7Notice[]>()
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private last = 0

  constructor(private readonly host: Ma7NoticesHost) {}

  list(): AppNotice[] {
    // An account that was logged out takes its notices with it, even before the next round.
    const accounts = new Set(this.host.accounts())
    return toAppNotices(new Map([...this.cache].filter(([login]) => accounts.has(login))))
  }

  start(): void {
    if (this.timer) return
    const tick = (): void => {
      void this.refresh()
      this.timer = setTimeout(tick, EVERY_MS)
    }
    this.timer = setTimeout(tick, FIRST_MS)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The window came to the front, or an account was added: look again unless it was looked a moment ago. */
  poke(): void {
    const now = (this.host.now ?? Date.now)()
    const added = this.host.accounts().some((l) => !this.cache.has(l))
    if (added || now - this.last >= FOCUS_MS) void this.refresh()
  }

  refresh(): Promise<void> {
    return (this.running ??= this.round().finally(() => {
      this.running = null
    }))
  }

  private async round(): Promise<void> {
    this.last = (this.host.now ?? Date.now)()
    const accounts = this.host.accounts()
    let changed = false
    for (const login of [...this.cache.keys()]) {
      if (!accounts.includes(login)) {
        this.cache.delete(login)
        changed = true
      }
    }
    for (const login of accounts) {
      try {
        const fresh = await this.host.fetch(login)
        if (JSON.stringify(this.cache.get(login)) !== JSON.stringify(fresh)) changed = true
        this.cache.set(login, fresh)
        const gone = forgotten(this.host.dismissed(), login, fresh)
        if (gone.length) this.host.forget(gone)
      } catch (err) {
        // Keep what was there: a network hiccup must not make the notices vanish and come back.
        // A login never answered still counts as asked, or every state change would ask it again.
        if (!this.cache.has(login)) this.cache.set(login, [])
        this.host.log('warn', `Уведомления MA7 не получены: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (changed) this.host.changed()
  }
}
