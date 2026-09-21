import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Tunnel } from '@shared/types'
import { AddTunnelDialog } from './components/AddTunnelDialog'
import { Dialog } from './components/Dialog'
import { Sheet } from './components/Sheet'
import { LogsView } from './components/LogsView'
import { RemoveScreen } from './components/RemoveScreen'
import { SettingsView } from './components/SettingsView'
import { Welcome } from './components/Welcome'
import { BottomNav, type View } from './components/BottomNav'
import {
  AddServerButton,
  ConnectionHero,
  ServerBar,
  TunnelList,
  UsageLine,
  type RowModel,
  type TunnelActions
} from './components/TunnelViews'
import { Button, IconButton, Logo } from './components/ui'
import { useAppState } from './hooks/useAppState'
import { useLayoutMode } from './hooks/useLayoutMode'
import { useLogs } from './hooks/useLogs'
import { useUiSettings } from './hooks/useUiSettings'
import { errorText } from './lib/errors'
import type { PingModel } from './lib/ping'
import { readSettingsTab, writeSettingsTab, type SettingsTab } from './lib/settingsTab'

/** A measurement describes one server at one moment; after this long it is no longer about now. */
const PING_TTL_MS = 15_000

const LAST_KEY = 'awg:lastTunnel'
const readLast = (): string | null => {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}
const VIEW_KEY = 'awg:view'
const readView = (): View => {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    // «logs» was its own tab before it moved into Настройки.
    return saved === 'logs' || saved === 'settings' ? 'settings' : 'tunnels'
  } catch {
    return 'tunnels'
  }
}
const writeView = (view: View): void => {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    /* per-viewer convenience only */
  }
}
const writeLast = (id: string): void => {
  try {
    localStorage.setItem(LAST_KEY, id)
  } catch {
    /* per-viewer convenience only */
  }
}

/**
 * The setup screen opens the application with ?from=setup (src/main/index.ts, prepareApp): it has just played
 * the greeting's entrance itself, so the greeting here must already stand assembled — the two are swapped
 * without a frame of difference, and playing the entrance again would show the swap.
 */
const FROM_SETUP = new URLSearchParams(window.location.search).get('from') === 'setup'

export default function App(): React.JSX.Element {
  const state = useAppState()
  const layout = useLayoutMode()
  const narrow = layout === 'narrow'
  const { entries: logEntries, clear: clearLogs } = useLogs()
  const [ui, setUi] = useUiSettings()

  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Tunnel | null>(null)
  // «Удалить AmnesiaWG»: the removal screen covers the window; `returning` while it flies back out.
  const [uninstall, setUninstall] = useState<{ keepData: boolean; returning: boolean } | null>(null)
  const [uninstallError, setUninstallError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  // First run: the welcome screen stays up after the first key is saved, until its note has been seen.
  const [welcoming, setWelcoming] = useState(false)
  const [entered, setEntered] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Tied to the server it was measured on, so switching servers does not carry the number over.
  const [ping, setPing] = useState<{ id: string; ms: number | null } | null>(null)
  const [pinging, setPinging] = useState(false)
  const forgetPing = useCallback(() => setPing(null), [])
  const [lastId, setLastId] = useState<string | null>(readLast)
  const [view, setView] = useState<View>(readView)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => {
    try {
      // «Логи» was a tab of its own before it moved into Настройки, where it is now «Диагностика».
      if (localStorage.getItem('awg:view') === 'logs') return 'diagnostics'
    } catch {
      /* fall through */
    }
    return readSettingsTab()
  })

  const run = useCallback(async (job: () => Promise<unknown>): Promise<void> => {
    try {
      await job()
    } catch (e) {
      setNotice(errorText(e))
    }
  }, [])

  const actions: TunnelActions = useMemo(
    () => ({
      connect: (id) => {
        writeLast(id)
        setLastId(id)
        setNotice(null)
        forgetPing()
        void run(() => window.awg.connect(id))
      },
      disconnect: (id) => {
        forgetPing()
        void run(() => window.awg.disconnect(id))
      },
      remove: (t) => setRemoving(t)
    }),
    [forgetPing, run]
  )

  // Nothing else on screen tells the number how old it is, so it goes on its own.
  useEffect(() => {
    if (!ping) return
    const timer = setTimeout(forgetPing, PING_TTL_MS)
    return () => clearTimeout(timer)
  }, [ping, forgetPing])
  // And it goes the moment the screen changes under it — the list opening or closing, a new view.
  // One rule instead of a call in each handler: Escape and the scrim leave by their own paths.
  useEffect(forgetPing, [picking, view, forgetPing])

  const holdWelcome = useCallback((on: boolean) => {
    setWelcoming(on)
    if (!on) {
      setView('tunnels')
      writeView('tunnels')
      setEntered(true)
    }
  }, [])

  if (!state) return <div className="app" aria-busy="true" />
  if (state.tunnels.length === 0 || welcoming) {
    return (
      <div className={`app app-${layout}${FROM_SETUP ? ' app-still' : ''}`}>
        <Welcome hold={holdWelcome} />
      </div>
    )
  }

  const { tunnels, states, activeId, busy } = state
  const current = tunnels.find((t) => t.id === (activeId ?? lastId)) ?? tunnels[0]
  const rows: RowModel[] = tunnels.map((tunnel) => ({
    tunnel,
    state: states[tunnel.id] ?? { id: tunnel.id, status: 'down' },
    current: tunnel.id === current?.id
  }))
  const selectable = !busy
  // Picking another server while one is running switches to it right away.
  const select = (id: string): void => {
    setPicking(false)
    if (activeId !== null && activeId !== id) {
      actions.connect(id)
      return
    }
    writeLast(id)
    setLastId(id)
  }

  const checkPing = (): void => {
    if (!current) return
    const { id } = current
    setPinging(true)
    void window.awg
      .ping(id)
      .then((ms) => setPing({ id, ms }))
      .catch(() => setPing({ id, ms: null }))
      .finally(() => setPinging(false))
  }
  const live = current !== undefined && activeId === current.id
  const pingModel: PingModel = {
    // Only the running server's own number: disconnecting or switching takes it off the bar.
    ms: live && ping?.id === current.id ? ping.ms : undefined,
    busy: pinging,
    enabled: live && !busy,
    check: checkPing
  }

  // From the sheet: the list it was opened for is replaced by the dialog, so the sheet goes away first.
  const addServer = (): void => {
    setPicking(false)
    setAdding(true)
  }

  const sheetOpen = picking && view === 'tunnels' && tunnels.length > 0
  const selectSettingsTab = (tab: SettingsTab): void => {
    setSettingsTab(tab)
    writeSettingsTab(tab)
  }
  // The journal fills the page instead of scrolling with it.
  const showingJournal = view === 'settings' && settingsTab === 'diagnostics'
  const navigate = (next: View): void => {
    setPicking(false)
    setView(next)
    writeView(next)
  }

  const list = current && (
    <ConnectionHero
      tunnel={current}
      state={states[current.id] ?? { id: current.id, status: 'down' }}
      busy={busy}
      switching={state.switching}
      actions={actions}
    />
  )

  return (
    <div className={`app app-${layout}${entered ? ' app-enter' : ''}${uninstall && !uninstall.returning ? ' app-removing' : ''}`}>
      <div className="stage">
        <main className={`content${showingJournal ? ' content-locked' : ''}`} inert={sheetOpen || uninstall !== null}>
          <div className="titlebar-drag" aria-hidden="true" />
          <header className="page-header">
            <Logo />
            <h1 className="brand">
              <span className="brand-name">AmnesiaWG</span>
              <span className="brand-version">v{__APP_VERSION__}</span>
            </h1>
            {view === 'tunnels' && tunnels.length > 0 &&
              (narrow ? (
                <IconButton
                  className="header-action header-add"
                  icon="plus"
                  label="Добавить сервер"
                  onClick={() => setAdding(true)}
                />
              ) : (
                <Button className="header-action" variant="text" icon="plus" onClick={() => setAdding(true)}>
                  Добавить сервер
                </Button>
              ))}
          </header>

          <div className={`content-body${showingJournal ? ' content-fill' : ' content-hero'}`}>
            {view === 'settings' ? (
              <SettingsView
                tab={settingsTab}
                onTab={selectSettingsTab}
                logs={<LogsView entries={logEntries} onClear={clearLogs} />}
                settings={ui}
                keyDns={current?.dns ?? []}
                diagnostics={state.diagnostics}
                onChange={setUi}
                onDiagnostics={(enabled) => void run(() => window.awg.setDiagnostics(enabled))}
                uninstallError={uninstallError}
                onUninstall={(keepData) => {
                  setUninstallError(null)
                  setUninstall({ keepData, returning: false })
                }}
              />
            ) : (
              <>
                {state.needsCleanup && !activeId && (
                  <div className="notice notice-warn" role="status">
                    <span>
                      Прошлое подключение завершилось без отключения — его DNS и маршрут до сервера могут быть ещё
                      применены.
                    </span>
                    <Button variant="tonal" disabled={busy} onClick={() => void run(() => window.awg.cleanup())}>
                      Восстановить сеть
                    </Button>
                  </div>
                )}
                {notice && (
                  <div className="notice" role="alert">
                    <span>{notice}</span>
                    <IconButton icon="close" label="Закрыть сообщение" onClick={() => setNotice(null)} />
                  </div>
                )}
                {list}
              </>
            )}
          </div>
        </main>

        <Sheet open={sheetOpen} title="Серверы" onClose={() => setPicking(false)} action={<AddServerButton onClick={addServer} />}>
          {activeId !== null && selectable && <p className="hint">Выбор другого сервера сразу переключит на него.</p>}
          <TunnelList rows={rows} selectable={selectable} onSelect={select} actions={actions} />
        </Sheet>
      </div>

      {view === 'tunnels' && current && (
        <ServerBar
          tunnel={current}
          expanded={sheetOpen}
          onToggle={() => setPicking((v) => !v)}
          usage={<UsageLine state={states[current.id] ?? { id: current.id, status: 'down' }} ui={ui} hidden={sheetOpen} />}
          ping={pingModel}
        />
      )}
      <BottomNav view={view} onNavigate={navigate} inert={uninstall !== null} />
      {uninstall && (
        <RemoveScreen
          keepData={uninstall.keepData}
          onReturn={() => setUninstall((u) => (u ? { ...u, returning: true } : u))}
          onClosed={(error) => {
            setUninstall(null)
            setUninstallError(error)
          }}
        />
      )}


      {adding && (
        <AddTunnelDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            setNotice(null)
          }}
        />
      )}

      {removing && (
        <Dialog
          title="Удалить сервер?"
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button variant="tonal" onClick={() => setRemoving(null)}>
                Отмена
              </Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={() => {
                  const id = removing.id
                  setRemoving(null)
                  void run(() => window.awg.removeTunnel(id))
                }}
              >
                Удалить
              </Button>
            </>
          }
        >
          <p>
            «{removing.name}» и его ключи будут удалены с этого компьютера. Чтобы вернуть сервер, понадобится
            ссылка vpn:// снова.
          </p>
        </Dialog>
      )}
    </div>
  )
}
