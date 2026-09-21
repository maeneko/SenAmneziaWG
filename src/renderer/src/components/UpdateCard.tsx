import { useEffect, useState } from 'react'
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
    case 'ready':
      return { icon: 'up', tone: 'new', title: `SenAWG ${state.version} готова к установке` }
    case 'installing':
      return { icon: 'spin', tone: 'busy', title: `Устанавливаем SenAWG ${state.version}…` }
    case 'failed':
      // Not a failure of this attempt but a fact about the copy: a warning, not an error.
      if (state.reason !== 'network') return { icon: 'shield', tone: 'warn', title: FAILED[state.reason] }
      return { icon: 'close', tone: 'error', title: FAILED.network }
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
              <div
                className="update-bar"
                role="progressbar"
                aria-label="Загрузка обновления"
                aria-valuemin={0}
                aria-valuemax={state.total}
                aria-valuenow={state.received}
              >
                <span style={{ transform: `scaleX(${state.total ? state.received / state.total : 0})` }} />
              </div>
              <p className="hint mono">
                {formatBytes(state.received, units)} из {formatBytes(state.total, units)}
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
              <Notes notes={state.notes} />
            </>
          )}
          {state.kind === 'installing' && <p className="hint">Приложение закроется и откроется снова.</p>}
          {state.kind === 'failed' && <p className="hint">{state.message}</p>}
        </div>
      </div>

      {state.kind === 'available' ? (
        <Button className="update-action" icon="down" onClick={() => void api.downloadUpdate()}>
          Скачать обновление
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
