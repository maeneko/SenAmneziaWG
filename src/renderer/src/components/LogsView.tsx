import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { REPORT_LOGS_WINDOW_MS, type LogEntry, type LogLevel, type Tunnel } from '@shared/types'
import { pluralEntries } from '../lib/format'
import { hasAccessToken } from '@shared/account'
import { collapseRepeats, filterLogs, formatTime, type LogFilter } from '../lib/logs'
import { ReportDialog } from './ReportDialog'
import { Button, IconButton } from './ui'

const FILTERS: { id: LogFilter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'app', label: 'Приложение' },
  { id: 'tunnel', label: 'Туннель' }
]

// Colour alone must not carry meaning: warnings and errors also get a text badge.
const BADGE: Partial<Record<LogLevel, string>> = { warn: 'warn', error: 'error' }

/** Distance from the bottom (px) within which the view keeps following new lines. */
const FOLLOW_SLACK = 24

interface LogsViewProps {
  entries: LogEntry[]
  onClear: () => Promise<void>
  /** MA7 accounts on this computer: «Репорт» is sent from one of them. */
  accounts: string[]
  /** The servers, and the one picked in the app: «Репорт» asks which one the trouble is with, that one first. */
  tunnels: Tunnel[]
  currentId: string | null
}

export function LogsView({ entries, onClear, accounts, tunnels, currentId }: LogsViewProps): React.JSX.Element {
  const [filter, setFilter] = useState<LogFilter>('all')
  const [reporting, setReporting] = useState(false)
  // MA7 takes a report only with the access token (shared/account.ts), as it does payment.
  const reporters = useMemo(() => accounts.filter(hasAccessToken), [accounts])
  const [copied, setCopied] = useState(false)
  const [away, setAway] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)

  const rows = useMemo(() => filterLogs(entries, filter), [entries, filter])
  const runs = useMemo(() => collapseRepeats(rows), [rows])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [runs.length, rows.length, filter])

  // Re-pin to the bottom when the window is resized: line wrapping changes the scroll height.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  function onScroll(): void {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK
    follow.current = near
    setAway(!near)
  }

  function jumpToLatest(): void {
    const el = scroller.current
    if (!el) return
    follow.current = true
    setAway(false)
    el.scrollTop = el.scrollHeight
  }

  return (
    <>
      <div className="log-toolbar">
        <div className="seg" role="group" aria-label="Источник записей">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`seg-btn sl${filter === f.id ? ' seg-btn-active' : ''}`}
              aria-pressed={filter === f.id}
              onClick={() => {
                follow.current = true
                setFilter(f.id)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="log-count">{pluralEntries(rows.length)}</span>
        <div className="log-actions">
          {/* The journal with a note to MA7 (ReportDialog), sent from an MA7 account: with none on this computer there
              is no «Профиль» and nothing to send it from, so no button. An account from an old link (no access
              token) gets it disabled, the title saying how to get a new one. */}
          {accounts.length > 0 && (
            <Button
              variant="tonal"
              icon="up"
              disabled={reporters.length === 0}
              title={reporters.length > 0 ? undefined : 'Нужен новый мастер-ключ из бота'}
              onClick={() => setReporting(true)}
            >
              Репорт
            </Button>
          )}
          <Button
            variant="tonal"
            icon={copied ? 'check' : 'copy'}
            disabled={rows.length === 0}
            onClick={() => void window.awg.copyLogs(filter).then(() => setCopied(true), () => setCopied(false))}
          >
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
          <IconButton
            icon="trash"
            tone="danger"
            label="Очистить журнал"
            disabled={entries.length === 0}
            onClick={() => void onClear()}
          />
          <span className="visually-hidden" role="status">
            {copied ? 'Журнал скопирован в буфер обмена' : ''}
          </span>
        </div>
      </div>

      <div className="log-panel">
        <div ref={scroller} className="log-scroll" role="log" aria-label="Журнал событий" tabIndex={0} onScroll={onScroll}>
          {runs.length === 0 ? (
            <p className="log-empty">
              Журнал пуст. Здесь появятся события приложения и вывод amneziawg-go.
            </p>
          ) : (
            runs.map(({ entry: e, count }) => (
              <div key={e.id} className={`log-line log-${e.level}`}>
                <span className={`log-src log-src-${e.source}`}>
                  <span className="visually-hidden">{e.source === 'tunnel' ? 'туннель' : 'приложение'}</span>
                </span>
                <time className="log-time" dateTime={new Date(e.ts).toISOString()}>
                  {formatTime(e.ts)}
                </time>
                <span className="log-msg">
                  {BADGE[e.level] && <span className={`log-badge log-badge-${e.level}`}>{BADGE[e.level]}</span>}
                  {e.message}
                  {count > 1 && <span className="log-repeat"> ×{count}</span>}
                </span>
              </div>
            ))
          )}
        </div>
        {away && (
          <Button className="log-jump" variant="tonal" icon="down" onClick={jumpToLatest}>
            К последним
          </Button>
        )}
      </div>
      {reporting && (
        <ReportDialog
          logins={reporters}
          tunnels={tunnels}
          currentId={currentId}
          recentEntries={entries.filter((e) => e.ts >= Date.now() - REPORT_LOGS_WINDOW_MS).length}
          onClose={() => setReporting(false)}
        />
      )}
    </>
  )
}
