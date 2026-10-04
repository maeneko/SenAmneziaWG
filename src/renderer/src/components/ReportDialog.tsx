import { useRef, useState } from 'react'
import { REPORT_MESSAGE_MAX, type ReportPreview, type Tunnel } from '@shared/types'
import { accountName } from '@shared/account'
import { errorText } from '../lib/errors'
import { endpointHost, pluralEntries } from '../lib/format'
import { Dialog, type DialogHandle } from './Dialog'
import { Button, Select, Switch } from './ui'

/** The «not about a server» choice in the list of servers. */
const NO_SERVER = ''

/**
 * «Репорт»: what happened, in the person's words, and the server it happened on — the one picked in the app,
 * unless they choose another — to MA7's admin panel (main/index.ts → POST /api/page/report). Each behind its own
 * switch: the journal of the last half hour (logins and keys are already cut out of it, main/logger.ts) and what
 * the device is. Sent from an account with the access token: `logins` are only those.
 *
 * Two steps: «Далее» has main put the report together and shows it as it will go — every field, the journal
 * itself on request — and «Отправить» sends that very one; «Назад» returns to the form with everything kept.
 * The steps are one Dialog with `step`: going between them is animated, not a swap.
 */
export function ReportDialog({
  logins,
  tunnels,
  currentId,
  recentEntries,
  onClose
}: {
  logins: string[]
  tunnels: Tunnel[]
  /** The server picked in the app (running, or the last chosen): the report is about it unless changed. */
  currentId: string | null
  /** Journal entries of the last half hour: none — nothing to attach. */
  recentEntries: number
  onClose: () => void
}): React.JSX.Element {
  const [login, setLogin] = useState(logins[0])
  const [text, setText] = useState('')
  const [server, setServer] = useState(() => (currentId && tunnels.some((t) => t.id === currentId) ? currentId : NO_SERVER))
  const [withLogs, setWithLogs] = useState(recentEntries > 0)
  const [withDevice, setWithDevice] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ReportPreview | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [showDevice, setShowDevice] = useState(false)
  const [sent, setSent] = useState(false)

  // Every way out — «Отмена», «Готово», Escape, the scrim — plays the dialog's exit before it goes (Dialog.tsx,
  // animateClose); not while a request is on its way (canClose).
  const dialog = useRef<DialogHandle>(null)
  const close = (): void => dialog.current?.close()

  async function review(): Promise<void> {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setError(null)
    try {
      setPreview(await window.awg.prepareReport(login, message, { tunnelId: server || null, withLogs, withDevice }))
      setShowLogs(false)
      setShowDevice(false)
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  async function send(): Promise<void> {
    if (!preview || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.awg.sendReport(preview.id)
      setSent(true)
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  const back = (): void => {
    setPreview(null)
    setError(null)
  }

  if (sent) {
    return (
      <Dialog
        ref={dialog}
        step="sent"
        title="Репорт отправлен"
        animateClose
        onClose={onClose}
        actions={<Button onClick={close}>Готово</Button>}
      >
        <p className="pay-note">Спасибо! Репорт получен — мы посмотрим, что случилось.</p>
      </Dialog>
    )
  }

  if (preview) {
    return (
      <Dialog
        ref={dialog}
        step="review"
        title="Проверьте репорт"
        animateClose
        canClose={!busy}
        onClose={onClose}
        actions={
          <>
            <Button variant="tonal" disabled={busy} onClick={back}>
              Назад
            </Button>
            <Button icon="up" disabled={busy} autoFocus onClick={() => void send()}>
              {busy ? 'Отправляю…' : 'Отправить'}
            </Button>
          </>
        }
      >
        <p className="pay-note">Так репорт увидят в MA7 — ничего, кроме этого, не отправится.</p>
        <dl className="key-table report-summary">
          <div>
            <dt>Аккаунт</dt>
            <dd className="mono">{accountName(login)}</dd>
          </div>
          <div>
            <dt>Сервер</dt>
            <dd>{preview.server ?? 'Не связано с сервером'}</dd>
          </div>
          <div>
            <dt>Версия</dt>
            <dd className="mono">{preview.appVersion}</dd>
          </div>
          <div>
            <dt>Устройство</dt>
            {/* The system line alone here; all of it under «Показать данные об устройстве». */}
            <dd className={preview.systemInfo ? undefined : 'report-none'}>
              {preview.systemInfo?.split('\n', 1)[0].replace(/^Система:\s*/, '') ?? 'Не прикладываются'}
            </dd>
          </div>
          <div>
            <dt>Журнал</dt>
            <dd className={preview.logs ? undefined : 'report-none'}>
              {preview.logs ? `${pluralEntries(preview.logEntries)} за полчаса` : 'Не прикладывается'}
            </dd>
          </div>
        </dl>

        <div className="report-block">
          <span className="report-label">Сообщение</span>
          <p className="report-message">{preview.message}</p>
        </div>

        {preview.systemInfo && (
          <div className="report-block">
            <Button
              variant="text"
              icon="info"
              className="report-logs-toggle"
              aria-expanded={showDevice}
              onClick={() => setShowDevice((v) => !v)}
            >
              {showDevice ? 'Скрыть данные об устройстве' : 'Показать данные об устройстве'}
            </Button>
            {showDevice && <p className="report-device">{preview.systemInfo}</p>}
          </div>
        )}

        {preview.logs && (
          <div className="report-block">
            <Button variant="text" icon="logs" className="report-logs-toggle" aria-expanded={showLogs} onClick={() => setShowLogs((v) => !v)}>
              {showLogs ? 'Скрыть журнал' : 'Показать журнал'}
            </Button>
            {showLogs && (
              <pre className="report-logs mono" tabIndex={0} aria-label="Журнал, который будет отправлен">
                {preview.logs}
              </pre>
            )}
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
      </Dialog>
    )
  }

  return (
    <Dialog
      ref={dialog}
      step="form"
      title="Репорт"
      animateClose
      canClose={!busy}
      onClose={onClose}
      actions={
        <>
          <Button variant="tonal" disabled={busy} onClick={close}>
            Отмена
          </Button>
          <Button disabled={busy || !text.trim()} onClick={() => void review()}>
            {busy ? 'Собираю…' : 'Далее'}
          </Button>
        </>
      }
    >
      {tunnels.length > 0 && (
        <div className="field">
          <span className="report-label" id="report-server-label">
            На каком сервере неполадки
          </span>
          <Select
            aria-labelledby="report-server-label"
            value={server}
            disabled={busy}
            onChange={setServer}
            options={[
              ...tunnels.map((t) => ({ value: t.id, label: t.name, hint: endpointHost(t.endpoint) })),
              { value: NO_SERVER, label: 'Не связано с сервером' }
            ]}
          />
        </div>
      )}

      <div className="field">
        <textarea
          // The text is what the form is for: the focus starts here, not on the server list above it.
          autoFocus
          className="input report-text"
          aria-label="Что случилось"
          placeholder="Что случилось? Например: не подключается к серверу, после обновления пропал интернет…"
          maxLength={REPORT_MESSAGE_MAX}
          value={text}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
        />
        {error && <p className="form-error">{error}</p>}
      </div>

      {/* Several MA7 accounts on this computer: the report goes from the one picked. */}
      {logins.length > 1 && (
        <div className="seg" role="group" aria-label="Аккаунт">
          {logins.map((l) => (
            <button
              key={l}
              type="button"
              className={`seg-btn sl mono${l === login ? ' seg-btn-active' : ''}`}
              aria-pressed={l === login}
              disabled={busy}
              onClick={() => setLogin(l)}
            >
              {accountName(l)}
            </button>
          ))}
        </div>
      )}

      <label className="choice sl">
        <Switch checked={withLogs} disabled={busy || recentEntries === 0} onChange={setWithLogs} />
        <span className="choice-text">
          <span>Приложить журнал за полчаса</span>
          <span className="hint">
            {recentEntries === 0
              ? 'За последние полчаса в журнале ничего нет.'
              : 'Помогает найти причину. Ключи и логин в журнале уже скрыты.'}
          </span>
        </span>
      </label>

      <label className="choice sl">
        <Switch checked={withDevice} disabled={busy} onChange={setWithDevice} />
        <span className="choice-text">
          <span>Приложить данные об устройстве</span>
          <span className="hint">
            Система и её сборка, процессор и его загрузка за полчаса, память, место на диске, экран, движок и версии
            компонентов — без имени компьютера, пользователя и адресов. Версия SenAWG уходит всегда.
          </span>
        </span>
      </label>
    </Dialog>
  )
}
