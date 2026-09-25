import { useCallback, useEffect, useState } from 'react'
import type { KeyDevices, SubscriptionView } from '@shared/types'
import { errorText } from '../lib/errors'
import { formatAgo } from '../lib/format'
import { cachedDevices, loadDevices } from '../lib/keyDevices'
import { BindingsBar } from './BindingsBar'
import { Dialog } from './Dialog'
import { Button } from './ui'

const PLATFORMS: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux', android: 'Android', ios: 'iOS' }

/** One character for the round badge of a device: enough to tell the platforms apart at a glance. */
const PLATFORM_MARK: Record<string, string> = { macos: 'M', windows: 'W', linux: 'L', android: 'A', ios: 'i' }

/** The capsule next to the key's name: a word for the state, and a hint for the long story. */
const STATUS: Record<SubscriptionView['status'], { label: string; hint: string }> = {
  ok: { label: 'Активен', hint: 'Сервер ключа отвечает' },
  offline: { label: 'Нет связи', hint: 'Сервер ключа не отвечает; сохранённые настройки продолжают работать' },
  revoked: { label: 'Отозван', hint: 'Ключ отозван, или устройство удалено в панели' }
}

/** Seconds the «Отвязать» button stays locked after the question is asked: a second thought, not a reflex. */
const UNBIND_DELAY = 15

/** How long the bar of the slots is left to shrink before the key is removed. */
const UNBIND_BAR_MS = 1100

/**
 * «Ключ»: the master keys of this computer — who is bound to each, and the one thing that can be done to
 * a device from here: unbind this one. Other devices are only shown; the panel is where they are removed.
 */
export function KeyView({ subscriptions, runningId }: { subscriptions: SubscriptionView[]; runningId: string | null }): React.JSX.Element {
  return (
    <>
      {subscriptions.map((sub) => (
        <KeySection key={sub.id} sub={sub} running={runningId === sub.id} />
      ))}
    </>
  )
}

function KeySection({ sub, running }: { sub: SubscriptionView; running: boolean }): React.JSX.Element {
  // The last known list stands at once; the fresh one replaces it when the server answers.
  const [info, setInfo] = useState<KeyDevices | null>(() => cachedDevices(sub.id))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [unbinding, setUnbinding] = useState(false)
  const [wait, setWait] = useState(UNBIND_DELAY)

  // The countdown runs while the question is open, and starts over each time it is asked.
  useEffect(() => {
    if (!confirming) return
    setWait(UNBIND_DELAY)
    const t = setInterval(() => setWait((n) => Math.max(0, n - 1)), 1000)
    return () => clearInterval(t)
  }, [confirming])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setInfo(await loadDevices(sub.id, window.awg.getKeyDevices))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [sub.id])

  // Once on opening, and again whenever the server has just been heard from (a refresh, a poll).
  useEffect(() => {
    void load()
  }, [load, sub.checkedAt])

  async function refresh(): Promise<void> {
    setRefreshing(true)
    try {
      await window.awg.refreshSubscription(sub.id)
    } finally {
      setRefreshing(false)
    }
  }

  async function unbind(): Promise<void> {
    setUnbinding(true)
    try {
      // The bar in the dialog gives up the slot before the key goes: once it does, this page is left at once.
      await new Promise((r) => setTimeout(r, UNBIND_BAR_MS))
      await window.awg.removeSubscription(sub.id)
      // The key leaves the state, and the page goes back to the servers by itself.
    } catch (e) {
      setConfirming(false)
      setError(errorText(e))
    } finally {
      setUnbinding(false)
    }
  }

  const now = Date.now()
  const used = info ? Math.min(100, Math.round((info.devices.length / Math.max(1, info.limit)) * 100)) : 0
  return (
    <section className="settings-group key-card" aria-labelledby={`key-${sub.id}`}>
      <header className="key-head">
        <div className="key-head-main">
          <h2 id={`key-${sub.id}`} className="key-name">
            {sub.name || 'Мастер-ключ'}
          </h2>
          <span className={`key-state key-state-${sub.status}`} title={STATUS[sub.status].hint}>
            {STATUS[sub.status].label}
          </span>
        </div>
        <p className="key-checked">{sub.checkedAt ? `Проверено ${formatAgo(sub.checkedAt / 1000, now)}` : 'Ещё не проверялся'}</p>
      </header>

      <div className="key-devices-head">
        <h3 className="key-devices-title">Устройства</h3>
        {info && (
          <span className="key-devices-count" title="Занято мест из лимита ключа">
            {info.devices.length} из {info.limit}
          </span>
        )}
      </div>
      {info && (
        <div className="key-meter" role="presentation">
          <span className={used >= 100 ? 'key-meter-full' : undefined} style={{ width: `${used}%` }} />
        </div>
      )}
      {error && <p className="form-error key-error">{error}</p>}
      {info && (
        <ul className="key-devices" aria-label="Устройства мастер-ключа" aria-busy={loading || undefined}>
          {info.devices.map((d) => (
            <li key={d.id} className={`key-device${d.current ? ' key-device-current' : ''}`}>
              <span className="key-device-mark" aria-hidden="true">
                {PLATFORM_MARK[d.platform] ?? '?'}
              </span>
              <span className="key-device-body">
                <span className="key-device-name">{d.name || 'Без имени'}</span>
                <span className="key-device-sub">
                  {[PLATFORMS[d.platform] ?? d.platform, d.version && `v${d.version}`].filter(Boolean).join(' ') || 'неизвестно'}
                  {' · '}
                  {d.lastSeen ? `активность ${formatAgo(d.lastSeen, now)}` : 'ещё не выходило на связь'}
                </span>
              </span>
              {d.current && <span className="key-device-you">это устройство</span>}
            </li>
          ))}
        </ul>
      )}
      {!info && loading && <p className="hint">Загрузка…</p>}

      <div className="key-actions">
        <Button variant="tonal" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? 'Обновляю…' : 'Обновить настройки'}
        </Button>
        <Button variant="danger" icon="trash" disabled={running} onClick={() => setConfirming(true)}>
          Отвязать это устройство
        </Button>
      </div>
      {running && <p className="key-note">Чтобы отвязать устройство, сначала отключитесь от серверов ключа.</p>}

      {confirming && (
        <Dialog
          title="Отвязать это устройство?"
          onClose={() => !unbinding && setConfirming(false)}
          actions={
            <>
              <Button variant="tonal" disabled={unbinding} onClick={() => setConfirming(false)}>
                Оставить
              </Button>
              <Button variant="danger" icon="trash" disabled={unbinding || wait > 0} onClick={() => void unbind()}>
                {wait > 0 ? `Отвязать (${wait})` : 'Отвязать'}
              </Button>
            </>
          }
        >
          <p>
            Сервер забудет этот компьютер, а место в лимите освободится. Серверы ключа «{sub.name}» и их ключи
            удалятся с компьютера. Чтобы вернуть их, понадобится ссылка sen:// снова.
          </p>
          {info && (
            <BindingsBar
              from={info.devices.length}
              to={unbinding ? Math.max(0, info.devices.length - 1) : info.devices.length}
              limit={info.limit}
            />
          )}
        </Dialog>
      )}
    </section>
  )
}
