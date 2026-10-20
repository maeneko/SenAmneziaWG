import { useEffect, useRef, useState } from 'react'
import type { ByteUnits } from '@shared/uiSettings'
import type { UpdateApi, UpdateState } from '@shared/types'
import { formatBytes } from '../lib/format'
import { Button, Icon, Switch, type IconName } from './ui'

/** A check this recent was the one just asked for: say its answer, not its clock time. */
const JUST_NOW = 60_000

const time = (at: number): string => {
  const d = new Date(at)
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? `сегодня в ${hm}` : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + ` в ${hm}`
}

/** What each state looks like: the mark on the left, its tone, and the one line that says it. */
function head(state: UpdateState): { icon: IconName | 'spin'; tone: 'ok' | 'new' | 'busy' | 'warn' | 'error'; title: string } {
  switch (state.kind) {
    case 'idle':
      return { icon: 'check', tone: 'ok', title: `SenAWG ${__APP_VERSION__} — последняя версия` }
    case 'checking':
      return { icon: 'spin', tone: 'busy', title: 'Проверяем обновления…' }
    case 'available':
      return { icon: 'down', tone: 'new', title: `Доступна SenAWG ${state.version}` }
    case 'downloading':
      return { icon: 'down', tone: 'busy', title: `Загружается SenAWG ${state.version}` }
    case 'paused':
      return { icon: 'pause', tone: 'new', title: `Загрузка SenAWG ${state.version} на паузе` }
    case 'ready':
      return { icon: 'up', tone: 'new', title: `SenAWG ${state.version} готова к установке` }
    case 'installing':
      return { icon: 'spin', tone: 'busy', title: `Готовим SenAWG ${state.version}…` }
    case 'failed':
      // Not a failure of this attempt but a fact about the copy: a warning, not an error.
      if (state.reason !== 'network') return { icon: 'shield', tone: 'warn', title: FAILED[state.reason] }
      return { icon: 'close', tone: 'error', title: state.installing ? 'Не удалось установить обновление' : FAILED.network }
  }
}

const FAILED = {
  network: 'Не удалось проверить обновления',
  revoked: 'Обновления для этой копии отключены',
  unsupported: 'Обновления по воздуху недоступны для данной версии SenAWG'
} as const

function Notes({ notes }: { notes: string[] }): React.JSX.Element | null {
  if (!notes.length) return null
  return (
    <details className="update-notes">
      <summary>Что нового</summary>
      <ul>
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </details>
  )
}

/** The update as the main process has it, kept up to date; null until it first answers. */
export function useUpdateState(api: UpdateApi): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    let alive = true
    void api.getUpdate().then((s) => alive && setState(s))
    const off = api.onUpdate((s) => alive && setState(s))
    return () => {
      alive = false
      off()
    }
  }, [api])
  return state
}

/** How far the download is: filling as the file comes, standing still on a pause. */
function Progress({ received, total }: { received: number; total: number }): React.JSX.Element {
  return (
    <div className="update-bar" role="progressbar" aria-label="Загрузка обновления" aria-valuemin={0} aria-valuemax={total} aria-valuenow={received}>
      <span style={{ transform: `scaleX(${total ? Math.min(1, received / total) : 0})` }} />
    </div>
  )
}

/** Running on its own while the new version is put in place: how long that takes, nobody knows. */
function Running(): React.JSX.Element {
  return (
    <div className="update-bar update-bar-running" role="progressbar" aria-label="Установка обновления">
      <span />
    </div>
  )
}

/**
 * «Обновления». Checking and downloading happen by themselves; the one thing the user decides is when
 * to restart into the new version, because that briefly drops the connection.
 */
export function UpdateCard({ api, units, automatic, onAutomatic }: {
  api: UpdateApi
  units: ByteUnits
  /** «Обновлять автоматически»: off, nothing is checked or downloaded until the button is pressed. */
  automatic: boolean
  onAutomatic: (on: boolean) => void
}): React.JSX.Element | null {
  const state = useUpdateState(api)

  // «только что» turns into the clock time once it stops being true.
  const [, setTick] = useState(0)
  const checkedAt = state?.kind === 'idle' ? state.checkedAt : null
  useEffect(() => {
    const left = checkedAt === null ? -1 : checkedAt + JUST_NOW - Date.now()
    if (left < 0) return
    const t = setTimeout(() => setTick((n) => n + 1), left + 50)
    return () => clearTimeout(t)
  }, [checkedAt])

  if (!state) return null
  const { icon, tone, title } = head(state)
  const busy = state.kind === 'checking' || state.kind === 'installing'

  return (
    <section className="settings-group" aria-labelledby="set-update">
      <h2 id="set-update" className="settings-title">Обновления</h2>
      <div className="update-card" data-tone={tone} data-kind={state.kind}>
        <span className="update-mark" aria-hidden="true">
          {icon === 'spin' ? <span className="update-spin" /> : <Icon name={icon} size={18} />}
        </span>
        <div className="update-body" role="status" aria-live="polite">
          <p className="update-title">{title}</p>

          {state.kind === 'idle' && (
            <p className="hint">
              {state.checkedAt === null
                ? automatic
                  ? 'Ещё не проверялось'
                  : 'Автоматически не проверяется'
                : Date.now() - state.checkedAt < JUST_NOW
                  ? 'Обновлений нет — проверено только что'
                  : `Обновлений нет · проверено ${time(state.checkedAt)}`}
            </p>
          )}
          {state.kind === 'checking' && <p className="hint">Сейчас установлена {__APP_VERSION__}</p>}

          {state.kind === 'available' && (
            <>
              <p className="hint">
                Сейчас установлена {__APP_VERSION__}. Загрузка — {formatBytes(state.total, units)}, после неё
                спросим, когда перезапустить.
              </p>
              <Notes notes={state.notes} />
            </>
          )}

          {state.kind === 'downloading' && (
            <>
              <Progress received={state.received} total={state.total} />
              <p className="hint mono">
                {formatBytes(state.received, units)} из {formatBytes(state.total, units)}
              </p>
              <Notes notes={state.notes} />
            </>
          )}
          {state.kind === 'paused' && (
            <>
              <Progress received={state.received} total={state.total} />
              <p className="hint">
                <span className="mono">
                  {formatBytes(state.received, units)} из {formatBytes(state.total, units)}
                </span>
                . Загруженное сохранится, загрузка продолжится с того же места.
              </p>
              <Notes notes={state.notes} />
            </>
          )}

          {state.kind === 'ready' && (
            <>
              <p className="hint">
                Сейчас установлена {__APP_VERSION__}. Подпись проверена. Если VPN включён, он прервётся на
                несколько секунд и подключится снова сам.
              </p>
              {state.message && <p className="hint">{state.message}</p>}
              <Notes notes={state.notes} />
            </>
          )}
          {state.kind === 'installing' && (
            <>
              <Running />
              <p className="hint">
                Подготовим новую версию, не закрывая приложение. Затем окно мигнёт и откроется снова, а VPN
                подключится сам.
              </p>
            </>
          )}
          {state.kind === 'failed' && <p className="hint">{state.message}</p>}
        </div>
      </div>

      {state.kind === 'available' ? (
        <Button className="update-action" icon="down" onClick={() => void api.downloadUpdate()}>
          Скачать обновление
        </Button>
      ) : state.kind === 'downloading' ? (
        // Pause and go on across the whole card: the one thing to do while it downloads.
        <Button className="update-action update-action-wide" variant="tonal" icon="pause" onClick={() => void api.pauseUpdate()}>
          Пауза
        </Button>
      ) : state.kind === 'paused' ? (
        <Button className="update-action update-action-wide" icon="play" onClick={() => void api.downloadUpdate()}>
          Продолжить загрузку
        </Button>
      ) : state.kind === 'ready' ? (
        <Button className="update-action" icon="up" onClick={() => void api.installUpdate()}>
          Перезапустить и обновить
        </Button>
      ) : state.kind === 'failed' && (state.reason === 'revoked' || state.reason === 'unsupported') ? null : state.kind === 'failed' ? (
        <Button className="update-action" variant="tonal" onClick={() => void api.checkForUpdate()}>
          Повторить
        </Button>
      ) : state.kind === 'idle' || state.kind === 'checking' ? (
        <Button className="update-action" variant="tonal" disabled={busy} onClick={() => void api.checkForUpdate()}>
          Проверить обновления
        </Button>
      ) : null}

      <label className="choice sl">
        <Switch checked={automatic} onChange={onAutomatic} />
        <span className="choice-text">
          <span>Обновлять автоматически</span>
          <span className="hint">
            Проверять несколько раз в день и заранее загружать новую версию. Ставится она всё равно только по
            вашей кнопке.
          </span>
        </span>
      </label>
    </section>
  )
}

/** The states the capsule on the main screen is there for: an update on its way. */
const ON_ITS_WAY = new Set<UpdateState['kind']>(['available', 'downloading', 'paused', 'ready', 'installing'])

const percent = (received: number, total: number): string => `${total > 0 ? Math.min(100, Math.max(0, Math.round((received * 100) / total))) : 0}%`

/**
 * A capsule the width of the server bar, over it, while an update is on its way: what it is doing, a progress bar
 * while it downloads or installs, and a click that does the next thing — install what is ready, fetch what was
 * found or go on with a paused download, or open «Обновления» (where the download is paused) meanwhile.
 * It comes and goes like the usage line; what it said last stays on it while it leaves.
 */
export function UpdatePill({ state, onInstall, onDownload, onOpen }: {
  state: UpdateState | null
  onInstall: () => void
  /** Fetches what was found, or goes on with a paused download. */
  onDownload: () => void
  /** «Настройки → Приложение», where the card is. */
  onOpen: () => void
}): React.JSX.Element {
  const shown = state !== null && ON_ITS_WAY.has(state.kind)
  const last = useRef<UpdateState | null>(null)
  if (shown) last.current = state
  const s = last.current

  let text = ''
  let side: string | null = null
  let bar: React.ReactNode = null
  let click = onOpen
  switch (s?.kind) {
    case 'available':
      text = `Доступна SenAWG ${s.version}`
      side = 'Загрузить'
      click = onDownload
      break
    case 'downloading':
      text = `Загружается SenAWG ${s.version}`
      side = percent(s.received, s.total)
      bar = <Progress received={s.received} total={s.total} />
      break
    case 'paused':
      text = `Загрузка SenAWG ${s.version} на паузе`
      side = percent(s.received, s.total)
      bar = <Progress received={s.received} total={s.total} />
      click = onDownload
      break
    case 'ready':
      text = `SenAWG ${s.version} загружена`
      side = 'Установить'
      click = onInstall
      break
    case 'installing':
      text = `Устанавливается SenAWG ${s.version}`
      bar = <Running />
      break
  }
  const action = s?.kind === 'available' || s?.kind === 'ready'

  return (
    <div className={`update-pill-slot${shown ? ' update-pill-open' : ''}`} aria-hidden={!shown || undefined} inert={!shown}>
      <div className="update-pill-inner">
        <button type="button" className="update-pill sl" data-kind={s?.kind} onClick={click}>
          <span className="update-pill-row">
            <span className="update-pill-text">{text}</span>
            {side && <span className={`update-pill-side${action ? ' update-pill-action' : ''}`}>{side}</span>}
          </span>
          {bar}
        </button>
      </div>
    </div>
  )
}
