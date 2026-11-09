import { useRef, useEffect, useState, useContext } from 'react'
import type { SubscriptionView, Tunnel, TunnelState } from '@shared/types'
import type { UiSettings } from '@shared/uiSettings'
import { endpointHost, formatBytes, formatStopwatch, formatUptime } from '../lib/format'
import { pingText, type PingModel } from '../lib/ping'
import { ErrorText } from './ErrorText'
import { Button, Icon, IconButton, MasterTag, UiModeContext, VersionTag } from './ui'

export interface TunnelActions {
  connect: (id: string) => void
  disconnect: (id: string) => void
  remove: (tunnel: Tunnel) => void
}

export interface RowModel {
  tunnel: Tunnel
  state: TunnelState
  /** This is the server shown in the card above. */
  current: boolean
}

const isOn = (s: TunnelState): boolean => s.status === 'up' || s.status === 'connecting'

/** Big ring button with the state spelled out; the ring spins while the tunnel comes up or goes down. */
/**
 * The main screen with an MA7 account and no servers: its master key was revoked (the server deleted this
 * device) or unbound. The account stays, so the way back is a new key from the bot, or «Профиль» to pay first.
 */
export function NoKeyHero({ logins, onAdd, onProfile }: { logins: string[]; onAdd: () => void; onProfile: () => void }): React.JSX.Element {
  return (
    <section className="hero no-key" aria-labelledby="no-key-title">
      <span className="no-key-icon" aria-hidden="true">
        <Icon name="key" size={32} />
      </span>
      <h2 id="no-key-title" className="no-key-title">
        Нет ключа для подключения
      </h2>
      <p className="no-key-text">
        {logins.length === 1 ? (
          <>
            Мастер-ключ аккаунта <span className="mono">{logins[0]}</span> отозван или отвязан от этого компьютера.
          </>
        ) : (
          'Мастер-ключи ваших аккаунтов отозваны или отвязаны от этого компьютера.'
        )}{' '}
        Получите новый ключ в Telegram-боте MA7 и вставьте его сюда.
      </p>
      <div className="no-key-actions">
        <Button icon="plus" onClick={onAdd}>
          Добавить ключ
        </Button>
        <Button variant="tonal" icon="user" onClick={onProfile}>
          Профиль
        </Button>
      </div>
    </section>
  )
}

export function ConnectionHero({ tunnel, state, busy, switching, actions, usage, extra }: {
  tunnel: Tunnel
  state: TunnelState
  busy: boolean
  switching: boolean
  actions: TunnelActions
  /** Just above the button: the stat pills of the open tunnel (the wide modern column). */
  usage?: React.ReactNode
  /** Under the ring and the error: what belongs to the connection but is not the button (the split chip). */
  extra?: React.ReactNode
}): React.JSX.Element {
  const on = isOn(state)
  const stopping = busy && state.status === 'up'
  const spinning = state.status === 'connecting' || stopping
  const text = stopping
    ? 'Отключение…'
    : state.status === 'connecting'
      ? switching ? 'Переключение…' : 'Подключение…'
      : on ? 'Подключено' : 'Подключиться'
  return (
    <section className="hero" aria-label="Подключение">
      {usage}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={on ? `Отключить ${tunnel.name}` : `Подключить ${tunnel.name}`}
        aria-busy={spinning || undefined}
        title={on ? 'Нажмите, чтобы отключить' : undefined}
        disabled={busy}
        className={`power${spinning ? ' power-spin' : ''}${state.status === 'up' ? ' power-up' : ''}`}
        onClick={() => (on ? actions.disconnect(tunnel.id) : actions.connect(tunnel.id))}
      >
        <span className="power-text" aria-hidden="true">
          {text}
        </span>
      </button>
      <span className="visually-hidden" role="status">
        {text}
      </span>

      {state.error && (
        <p className="server-error" role="alert">
          <ErrorText text={state.error} />
        </p>
      )}
      {extra}
    </section>
  )
}

/**
 * Data used and connection age, in the form chosen in Настройки. The modern interface lays the
 * numbers into small stat pills (the age stopwatch leading with its clock, then the data), while
 * the legacy one keeps the plain muted line exactly as it was.
 */
function usageItems(state: TunnelState, ui: UiSettings, modern: boolean, now: number): React.JSX.Element[] | null {
  const stats = state.status === 'up' ? state.stats : undefined
  if (!stats || (ui.traffic === 'hidden' && !state.since)) return null
  const items: React.JSX.Element[] = []
  if (modern) {
    if (state.since) {
      items.push(
        <span key="since" className="usage-pill" title="Время подключения">
          <Icon name="clock" size={14} />
          <span className="mono">{formatStopwatch(state.since, now)}</span>
        </span>
      )
    }
    if (ui.traffic === 'total') {
      items.push(
        <span key="total" className="usage-pill" title="Скачано и отправлено с момента подключения">
          <span className="mono">{formatBytes(stats.rxBytes + stats.txBytes, ui.units)}</span>
        </span>
      )
    }
    if (ui.traffic === 'split') {
      items.push(
        <span key="rx" className="usage-pill" title="Скачано">
          <span className="mono">↓ {formatBytes(stats.rxBytes, ui.units)}</span>
        </span>,
        <span key="tx" className="usage-pill" title="Отправлено">
          <span className="mono">↑ {formatBytes(stats.txBytes, ui.units)}</span>
        </span>
      )
    }
  } else {
    if (ui.traffic === 'total') {
      items.push(
        <span key="total" title="Скачано и отправлено с момента подключения">
          потрачено <span className="mono">{formatBytes(stats.rxBytes + stats.txBytes, ui.units)}</span>
        </span>
      )
    }
    if (ui.traffic === 'split') {
      items.push(
        <span key="rx" className="mono" title="Скачано">↓ {formatBytes(stats.rxBytes, ui.units)}</span>,
        <span key="tx" className="mono" title="Отправлено">↑ {formatBytes(stats.txBytes, ui.units)}</span>
      )
    }
    if (state.since) items.push(<span key="since">подключено {formatUptime(state.since, Date.now())}</span>)
  }
  return items
}

/**
 * The line above the server bar. Its slot is always there and opens with the connection: the
 * height grows (nothing jumps), then the items rise in one after another. On disconnect the last
 * values stay visible while the slot closes.
 */
export function UsageLine({ state, ui, hidden = false }: {
  state: TunnelState
  ui: UiSettings
  /**
   * Faded out while the server list is open. Only faded, never collapsed: a height change here
   * would move the server bar and, with it, the sheet sliding up above it.
   */
  hidden?: boolean
}): React.JSX.Element {
  const modern = useContext(UiModeContext) === 'modern'
  // The stopwatch pill reads seconds, so in the modern mode it needs a heartbeat to tick on;
  // the legacy line keeps its minute-wise words without one.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!modern) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => clearInterval(tick)
  }, [modern])
  const items = usageItems(state, ui, modern, now)
  const open = items !== null
  const last = useRef<React.JSX.Element[]>([])
  const wasOpen = useRef(false)
  const run = useRef(0)
  // A new connection remounts the items, so their entrance animation plays again.
  if (open && !wasOpen.current) run.current++
  wasOpen.current = open
  if (items) last.current = items

  return (
    <div
      className={`usage-slot${open ? ' usage-open' : ''}${hidden ? ' usage-faded' : ''}`}
      aria-hidden={!open || hidden || undefined}
    >
      <div className="usage-inner">
        <p key={run.current} className="usage-line">
          {last.current}
        </p>
      </div>
    </div>
  )
}

/** Current server above the navigation bar; opens and closes the server list. */
export function ServerBar({ tunnel, expanded, onToggle, usage, above, ping, add }: {
  tunnel: Tunnel
  expanded: boolean
  onToggle: () => void
  /** Shown just above the bar, on the left. */
  usage?: React.ReactNode
  /** Over the bar and the usage line, taking room of its own: the update's capsule. */
  above?: React.ReactNode
  /** A round control standing to the right of the capsule (the add-server circle of the modern bar). */
  add?: React.ReactNode
  ping: PingModel
}): React.JSX.Element {
  const shown = pingText(ping)
  // The slot stays in the line and keeps its last text, so what fades out is the number itself
  // rather than an empty box. Same trick as the usage line above the bar.
  const last = useRef('')
  if (shown) last.current = shown
  // The area spans the full window width so the sheet's dimming can continue under the bar
  // (see .server-bar-area::before) instead of ending in a visible seam above it.
  return (
    <div className={`server-bar-area${expanded ? ' server-bar-dim' : ''}`}>
      <div className="server-bar-wrap">
        {above}
        <div className="server-bar-anchor">
          {usage}
          <div className="server-bar">
            <button
              type="button"
              className="server-bar-main sl"
              aria-haspopup="dialog"
              aria-expanded={expanded}
              onClick={onToggle}
            >
              <span className="server-bar-text">
                <span className="server-name">{tunnel.name}</span>
                <span className="row-sub">
                  <span className="mono">{endpointHost(tunnel.endpoint)}</span>
                  <span aria-hidden="true">·</span>
                  <VersionTag awg={tunnel.awg} />
                  <span className={`ping-slot${shown ? ' ping-shown' : ''}`} aria-hidden={!shown || undefined}>
                    <span aria-hidden="true">·</span>
                    <span className="ping-value">{last.current}</span>
                  </span>
                </span>
              </span>
              <span className="visually-hidden">— выбрать сервер</span>
              <Icon name="chevron" size={22} />
            </button>
            <IconButton
              className="server-bar-ping"
              icon="netcheck"
              label="Проверить задержку"
              title={ping.enabled ? 'Проверить задержку' : 'Сначала подключитесь'}
              disabled={!ping.enabled || ping.busy}
              onClick={ping.check}
            />
           </div>
          {add}
        </div>
      </div>
    </div>
  )
}

/** The one way to add a server from the list: a plus in the sheet's corner. */
export function AddServerButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="add-server sl" aria-label="Добавить сервер" title="Добавить сервер" onClick={onClick}>
      <Icon name="plus" size={18} />
    </button>
  )
}

/** What one master key's group says under its name: the state the person can act on, if any. */
function groupNote(sub: SubscriptionView | undefined): string | null {
  if (!sub) return null
  if (sub.status === 'revoked') return 'отозван'
  if (sub.pendingRev) return 'есть новые настройки'
  if (sub.status === 'offline') return 'нет связи с сервером ключа'
  return null
}

type ListItem = { kind: 'row'; row: RowModel } | { kind: 'group'; subId: string; rows: RowModel[] } | { kind: 'singles'; rows: RowModel[] }

/**
 * Servers of one master key sit together, in a block of their own under the key's name, wherever the
 * first of them stood; the other servers make one keyless block of their own where the first of
 * them stood. Each block then reads as one group: its rows segmented, its neighbours apart.
 */
function listItems(rows: RowModel[]): ListItem[] {
  const items: ListItem[] = []
  const groups = new Map<string, Extract<ListItem, { kind: 'group' }>>()
  // The servers without a master key of their own make one block of their own: they are a
  // group in the user's eye, just a keyless one (see TunnelList's wrapper).
  let singles: Extract<ListItem, { kind: 'singles' }> | null = null
  for (const row of rows) {
    const subId = row.tunnel.source?.subId
    if (!subId) {
      if (!singles) {
        singles = { kind: 'singles', rows: [] }
        items.push(singles)
      }
      singles.rows.push(row)
      continue
    }
    let group = groups.get(subId)
    if (!group) {
      group = { kind: 'group', subId, rows: [] }
      groups.set(subId, group)
      items.push(group)
    }
    group.rows.push(row)
  }
  return items
}

function TunnelRow({ row, selectable, onSelect, actions }: {
  row: RowModel
  selectable: boolean
  onSelect: (id: string) => void
  actions: TunnelActions
}): React.JSX.Element {
  const { tunnel, state, current } = row
  return (
    <li className={`tunnel-row${current ? ' tunnel-row-current' : ''}`}>
      <button
        type="button"
        className="tunnel-pick sl"
        aria-current={current ? 'true' : undefined}
        aria-disabled={!selectable && !current ? true : undefined}
        onClick={() => selectable && onSelect(tunnel.id)}
      >
        {/* The Meow-style tile: a round tag in front of the name — the key's own glyph for its
           servers, the globe for the standalone ones. Legacy keeps it out of sight (display:none). */}
        <span className="row-avatar" aria-hidden="true">
          <Icon name={tunnel.source ? 'key' : 'globe'} size={24} />
        </span>
        <span className="row-text">
          <span className="tunnel-name" title={tunnel.name}>
            {tunnel.name}
          </span>
          {/* Chumpy reads the version first and the address second; legacy keeps the address
              first, so the swap is a CSS order (see .row-sub below), not this markup. */}
          <span className="row-sub">
            <span className="mono">{endpointHost(tunnel.endpoint)}</span>
            <span aria-hidden="true">·</span>
            <VersionTag awg={tunnel.awg} />
          </span>
        </span>
      </button>
      {/* Servers of a master key are removed together with the key, from the key tab. */}
      {!tunnel.source && (
        <IconButton
          className="row-delete"
          icon="trash"
          tone="danger"
          label={`Удалить ${tunnel.name}`}
          title={isOn(state) ? 'Сначала отключите' : `Удалить ${tunnel.name}`}
          disabled={isOn(state)}
          onClick={() => actions.remove(tunnel)}
        />
      )}
    </li>
  )
}

/**
 * Servers to pick from. With nothing running a row only selects the server for the power button;
 * with a tunnel running it switches to that server. Rows are inert while an operation is in flight.
 * The servers of a master key are grouped under its name.
 */
export function TunnelList({ rows, subscriptions, selectable, onSelect, actions }: {
  rows: RowModel[]
  subscriptions: SubscriptionView[]
  selectable: boolean
  onSelect: (id: string) => void
  actions: TunnelActions
}): React.JSX.Element {
  return (
    <ul className="tunnel-list" aria-label="Серверы">
      {listItems(rows).map((item) => {
        if (item.kind === 'singles') {
          /* The keyless servers read as one more group, just without the key's name over it:
             no head, and legacy sees a plain run of rows through the wrapper. */
          return (
            <li key="singles" className="tunnel-block">
              <ul className="tunnel-block-rows" aria-label="Серверы без мастер-ключа">
                {item.rows.map((row) => (
                  <TunnelRow key={row.tunnel.id} row={row} selectable={selectable} onSelect={onSelect} actions={actions} />
                ))}
              </ul>
            </li>
          )
        }
        if (item.kind === 'row') {
          return <TunnelRow key={item.row.tunnel.id} row={item.row} selectable={selectable} onSelect={onSelect} actions={actions} />
        }
        const sub = subscriptions.find((x) => x.id === item.subId)
        const note = groupNote(sub)
        const name = sub?.name ?? item.rows[0].tunnel.name
        return (
          <li key={item.subId} className="tunnel-group">
            <div className="tunnel-group-head">
              <MasterTag />
              <span className="tunnel-group-name" title={name}>
                {name}
              </span>
              {note && <span className="tunnel-group-note">{note}</span>}
            </div>
            <ul className="tunnel-group-rows" aria-label={`Серверы мастер-ключа «${name}»`}>
              {item.rows.map((row) => (
                <TunnelRow key={row.tunnel.id} row={row} selectable={selectable} onSelect={onSelect} actions={actions} />
              ))}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}
