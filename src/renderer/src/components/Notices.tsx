import { useEffect, useRef, useState } from 'react'
import type { AppNotice } from '@shared/types'
import { orderNotices } from '../lib/notices'
import type { View } from './BottomNav'
import { Button, Icon, IconButton, type IconName } from './ui'

/** How long a closed card takes to fold away (app.css, .notice-card-leaving). */
const LEAVE_MS = 220

const ICON: Record<AppNotice['tone'], IconName> = { info: 'info', success: 'check', warn: 'alert', error: 'alert' }

/** The notifications of the main screen, most important first; kept up to date by the main process. */
export function useNotices(): AppNotice[] {
  const [notices, setNotices] = useState<AppNotice[]>([])
  useEffect(() => {
    let live = true
    void window.awg.getNotices().then((n) => live && setNotices(n))
    const off = window.awg.onNotices(setNotices)
    return () => {
      live = false
      off()
    }
  }, [])
  return orderNotices(notices)
}

/**
 * Notifications over the main screen, never in its flow: the connect button stays where it is whatever
 * comes. Folded, one line at the top — the most important, and how many more; opened, a panel over the page
 * with all of them, the important ones under their own heading. `inline`: the app's own warnings are up there already (and
 * have moved the button themselves), so the line takes its place under them instead of covering them.
 */
export function Notices({
  notices,
  onNavigate,
  inline
}: {
  notices: AppNotice[]
  onNavigate: (view: View) => void
  inline: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const panel = useRef<HTMLDivElement>(null)

  // The last one closed: nothing left to open.
  useEffect(() => {
    if (!notices.length) setOpen(false)
  }, [notices.length])

  // A closed card stays folded until the list without it comes: let go sooner, it would show again for a moment.
  const ids = notices.map((n) => n.id).join('\n')
  useEffect(() => {
    const present = new Set(ids.split('\n'))
    setLeaving((s) => ([...s].every((id) => present.has(id)) ? s : new Set([...s].filter((id) => present.has(id)))))
  }, [ids])

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!notices.length) return null
  const [top] = notices
  const more = notices.length - 1

  const dismiss = (id: string): void => {
    setLeaving((s) => new Set(s).add(id))
    setTimeout(() => {
      // Gone from the list, it is let go there (above); refused, it comes back.
      void window.awg.dismissNotice(id).catch(() =>
        setLeaving((s) => {
          const next = new Set(s)
          next.delete(id)
          return next
        })
      )
    }, LEAVE_MS)
  }
  const refresh = (): void => {
    setRefreshing(true)
    void window.awg.refreshNotices().finally(() => setRefreshing(false))
  }
  const go = (view: View): void => {
    setOpen(false)
    onNavigate(view)
  }
  // The important ones under a heading of their own, only when there is something else to set them apart from.
  const high = notices.filter((n) => n.priority === 'high')
  const rest = notices.filter((n) => n.priority !== 'high')
  // Keyed by kind, not by whether there are headings, so the group that stays is the same one and nothing remounts.
  // A group whose every card is closing folds away whole, and the other one's heading with it — it has nothing to
  // be set apart from any more.
  const gone = (items: AppNotice[]): boolean => items.every((n) => leaving.has(n.id))
  const groups =
    high.length && rest.length
      ? [
          { key: 'high', title: 'Важное', items: high, leaving: gone(high), titleLeaving: gone(high) || gone(rest) },
          { key: 'rest', title: 'Остальные', items: rest, leaving: gone(rest), titleLeaving: gone(high) || gone(rest) }
        ]
      : [{ key: high.length ? 'high' : 'rest', title: null, items: notices, leaving: false, titleLeaving: false }]

  const card = (n: AppNotice): React.JSX.Element => (
    <li key={n.id} className={`notice-card notice-card-${n.tone}${leaving.has(n.id) ? ' notice-card-leaving' : ''}`}>
      <div className="notice-card-inner">
        <span className="notice-card-icon" aria-hidden="true">
          <Icon name={ICON[n.tone]} size={18} />
        </span>
        <div className="notice-card-body">
          <p className="notice-card-title">{n.title}</p>
          {n.text && <p className="notice-card-text">{n.text}</p>}
          {n.action && (
            <Button className="notice-card-action" variant="text" onClick={() => go(n.action!.view)}>
              {n.action.label}
            </Button>
          )}
        </div>
        {n.dismissible && <IconButton className="notice-card-close" icon="close" label="Закрыть уведомление" onClick={() => dismiss(n.id)} />}
      </div>
    </li>
  )

  return (
    <div className={`notices${inline ? ' notices-inline' : ''}${open ? ' notices-open' : ''}`}>
      {!open && (
        // Keyed by the notice: the next one comes in as the closed one has gone, rather than taking its words in place.
        <div key={top.id} className={`notice-bar notice-card-${top.tone}${leaving.has(top.id) ? ' notice-bar-leaving' : ''}`}>
          <button type="button" className="notice-bar-open" aria-expanded={false} onClick={() => setOpen(true)}>
            <span className="notice-card-icon" aria-hidden="true">
              <Icon name={ICON[top.tone]} size={18} />
            </span>
            <span className="notice-bar-title">{top.title}</span>
            {more > 0 && <span className="notice-bar-more">+{more}</span>}
            <Icon name="chevron" size={16} className="notice-bar-chevron" />
          </button>
          {top.dismissible && <IconButton className="notice-card-close" icon="close" label="Закрыть уведомление" onClick={() => dismiss(top.id)} />}
        </div>
      )}

      {open && (
        <>
          <div className="notices-scrim" aria-hidden="true" onMouseDown={() => setOpen(false)} />
          <div ref={panel} className="notices-panel" role="dialog" aria-label="Уведомления" tabIndex={-1}>
            <div className="notices-panel-head">
              <h2 className="notices-panel-title">Уведомления</h2>
              <div className="notices-panel-actions">
                <IconButton
                  className={refreshing ? 'notices-refreshing' : undefined}
                  icon="refresh"
                  label="Обновить"
                  disabled={refreshing}
                  onClick={refresh}
                />
                <IconButton icon="chevron" label="Свернуть" onClick={() => setOpen(false)} />
              </div>
            </div>
            {groups.map((g) => (
              <section key={g.key} className={`notices-group${g.leaving ? ' notices-group-leaving' : ''}`} aria-label={g.title ?? undefined}>
                <div className="notices-group-inner">
                  {g.title && <h3 className={`notices-group-title${g.titleLeaving ? ' notices-group-title-leaving' : ''}`}>{g.title}</h3>}
                  <ul className="notices-list">{g.items.map(card)}</ul>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
