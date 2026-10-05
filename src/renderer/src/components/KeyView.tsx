import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { accountName, hasAccessToken } from '@shared/account'
import type { KeyDevices, SubscriptionView } from '@shared/types'
import { errorText } from '../lib/errors'
import { formatAgo } from '../lib/format'
import { cachedDevices, loadDevices } from '../lib/keyDevices'
import { cachedProfile } from '../lib/profiles'
import { BindingsBar } from './BindingsBar'
import { Dialog } from './Dialog'
import { KeysDialog } from './KeysDialog'
import { Button, IconButton } from './ui'

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
export function KeyView({ subscriptions: all, runningId }: { subscriptions: SubscriptionView[]; runningId: string | null }): React.JSX.Element {
  // The account's own key goes first, then the other keys tied to an account (the sort is stable, the rest keep
  // their order).
  const subscriptions = useMemo(() => [...all].sort((a, b) => keyRank(a) - keyRank(b)), [all])
  if (subscriptions.length < 2) {
    return (
      <>
        {subscriptions.map((sub) => (
          <KeySection key={sub.id} sub={sub} running={runningId === sub.id} />
        ))}
      </>
    )
  }
  return <KeyCarousel subscriptions={subscriptions} runningId={runningId} />
}

/**
 * Whether this is the account's own key. MA7 issues one master key per account and names it after the login;
 * other keys (a «Семья» made in the panel) can carry the same login after «#», but are not the account's own.
 */
function ownKey(sub: SubscriptionView): boolean {
  return sub.login !== undefined && sub.name === accountName(sub.login)
}

/** Where a key stands in the list: the account's own, then the others with an account, then the rest. */
function keyRank(sub: SubscriptionView): number {
  return ownKey(sub) ? 0 : sub.login !== undefined ? 1 : 2
}

/** The gap between two cards of the carousel, as in app.css (.key-carousel). */
const SLIDE_GAP = 12
/** A mouse that moved less than this between press and release clicked, not dragged. */
const DRAG_SLOP = 6
/** A drag this long turns the page even short of halfway. */
const DRAG_TURN = 48

/**
 * Several master keys: a card each, side by side, scrolled across and snapped to one at a time. The next card shows
 * its edge at the window's side, so it is plain there is more. The dots say which one is shown and take to any,
 * between «‹» and «›», on a bar of their own over the navigation (#key-foot in App.tsx): a card can be taller than
 * the window, so under it they would be out of reach, and floating over it they covered its buttons.
 *
 * Trackpads and Shift+wheel scroll it as they are, arrow keys too once it has the focus. A plain mouse wheel is left
 * to the page (the cards are tall); a mouse drags instead: pressed on a card and pulled aside, the track follows,
 * and let go it settles on the next card — or back, if the pull was short. A press that hardly moved is a click, and
 * reaches the button under it.
 *
 * Nothing in the carousel is positioned or transformed: the dialogs a card opens are laid over the page from above
 * it, and a containing block here would clip them to the card.
 */
function KeyCarousel({ subscriptions, runningId }: { subscriptions: SubscriptionView[]; runningId: string | null }): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; x: number; left: number; from: number; moved: boolean } | null>(null)
  // Set as a drag ends, for the click the browser sends right after it; cleared once that moment has passed.
  const dragged = useRef(false)
  const last = subscriptions.length - 1
  // The bar over the navigation the controls go to (App.tsx, #key-foot); here under the cards when there is none.
  const [foot, setFoot] = useState<HTMLElement | null>(null)
  useEffect(() => setFoot(document.getElementById('key-foot')), [])

  const step = (): number => {
    const first = track.current?.firstElementChild as HTMLElement | null | undefined
    return first ? first.offsetWidth + SLIDE_GAP : 1
  }
  const onScroll = (): void => {
    if (!track.current) return
    setShown(Math.min(last, Math.max(0, Math.round(track.current.scrollLeft / step()))))
  }
  const go = (i: number): void => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    track.current?.scrollTo({ left: Math.min(last, Math.max(0, i)) * step(), behavior: smooth ? 'smooth' : 'auto' })
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !track.current) return
    drag.current = { id: e.pointerId, x: e.clientX, left: track.current.scrollLeft, from: shown, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !track.current) return
    const dx = e.clientX - d.x
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return
      // A drag now: the track follows the hand, unsnapped, and keeps the pointer even past its edges.
      d.moved = true
      setDragging(true)
      track.current.setPointerCapture(e.pointerId)
    }
    track.current.scrollLeft = d.left - dx
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (!d.moved) return
    setDragging(false)
    dragged.current = true
    window.setTimeout(() => {
      dragged.current = false
    }, 0)
    const dx = e.clientX - d.x
    go(dx <= -DRAG_TURN ? d.from + 1 : dx >= DRAG_TURN ? d.from - 1 : d.from)
  }
  // The click that ends a drag is not a press on whatever the pointer was let go over.
  const onClickCapture = (e: React.MouseEvent): void => {
    if (!dragged.current) return
    e.stopPropagation()
    e.preventDefault()
  }

  const controls = (
    <div className="key-dots" role="group" aria-label="Листать ключи">
      <IconButton icon="chevron" className="key-turn key-turn-prev" label="Предыдущий ключ" disabled={shown === 0} onClick={() => go(shown - 1)} />
      {subscriptions.map((sub, i) => (
        <button
          key={sub.id}
          type="button"
          className={`key-dot${i === shown ? ' key-dot-on' : ''}`}
          aria-label={sub.name || `Мастер-ключ ${i + 1}`}
          aria-current={i === shown || undefined}
          title={sub.name || undefined}
          onClick={() => go(i)}
        />
      ))}
      <IconButton icon="chevron" className="key-turn key-turn-next" label="Следующий ключ" disabled={shown === last} onClick={() => go(shown + 1)} />
    </div>
  )

  return (
    <div className="key-carousel-wrap">
      <div
        ref={track}
        className={`key-carousel${dragging ? ' key-carousel-dragging' : ''}`}
        role="region"
        aria-roledescription="карусель"
        aria-label="Мастер-ключи"
        tabIndex={0}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        {subscriptions.map((sub, i) => (
          <div key={sub.id} className="key-slide" role="group" aria-roledescription="ключ" aria-label={`${i + 1} из ${subscriptions.length}: ${sub.name || 'Мастер-ключ'}`}>
            <KeySection sub={sub} running={runningId === sub.id} />
          </div>
        ))}
      </div>
      {foot ? createPortal(controls, foot) : controls}
    </div>
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
  const [adding, setAdding] = useState(false)

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
  // More places are bought on the MA7 account the key was issued to («Устройства», KeysDialog): only for the
  // account's own key (MA7 raises the limit of that one alone), only with its access token, and not while
  // «Профиль» last saw the subscription unpaid — MA7 would only say so.
  const login = sub.login
  const canAdd = login !== undefined && ownKey(sub) && hasAccessToken(login) && (cachedProfile(login)?.profile.status ?? 'active') === 'active'
  const full = info !== null && info.devices.length >= info.limit
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
          <span className="key-devices-side">
            <span className="key-devices-count" title="Занято мест из лимита ключа">
              {info.devices.length} из {info.limit}
            </span>
            {canAdd && <IconButton icon="plus" tone="accent" className="fact-add" label="Добавить места" onClick={() => setAdding(true)} />}
          </span>
        )}
      </div>
      {info && (
        <div className="key-meter" role="presentation">
          <span className={used >= 100 ? 'key-meter-full' : undefined} style={{ width: `${used}%` }} />
        </div>
      )}
      {full && canAdd && (
        // The moment a place is wanted: the next device would be turned away.
        <div className="key-full" role="status">
          <span>Все места заняты — новое устройство не подключится.</span>
          <Button variant="tonal" icon="plus" onClick={() => setAdding(true)}>
            Добавить
          </Button>
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

      {/* A place bought shows at once: the server raises the key's limit as MA7 issues the keys. */}
      {adding && login && <KeysDialog login={login} keys={info?.limit ?? 0} onClose={() => setAdding(false)} onChanged={() => void load()} />}

      {confirming && (
        <Dialog
          title="Отвязать это устройство?"
          fluid
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
