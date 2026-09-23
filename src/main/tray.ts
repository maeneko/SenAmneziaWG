import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import type { AppState } from '../shared/types'

export interface AppTray {
  /** Tooltip and menu follow the connection. */
  update(state: AppState): void
  /** «Работать в фоне»: the icon exists only while it is on. */
  setEnabled(on: boolean): void
  /** Once per run, the first time the window goes away: where the application went. */
  notifyHidden(): void
  dispose(): void
}

/** The notification-area icon wants 16 px at 100 %, 24 at 150 %, 32 at 200 %; one big PNG scales badly. */
function trayImage(path: string): NativeImage {
  const source = nativeImage.createFromPath(path)
  if (source.isEmpty()) return source
  const image = nativeImage.createEmpty()
  for (const [scaleFactor, size] of [[1, 16], [1.5, 24], [2, 32]] as const) {
    image.addRepresentation({ scaleFactor, buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG() })
  }
  return image
}

function tooltip(state: AppState | null): string {
  const active = state?.activeId ? state.tunnels.find((t) => t.id === state.activeId) : undefined
  if (!state || !active) return 'SenAWG — не подключено'
  const status = state.states[active.id]?.status
  if (status === 'up') return `SenAWG — подключено: ${active.name}`
  if (status === 'error') return `SenAWG — ошибка: ${active.name}`
  return `SenAWG — подключение: ${active.name}…`
}

/**
 * Windows only. With it, closing the window hides it instead of quitting, and the process — which the
 * service needs alive to keep the tunnel up — stays behind this icon.
 */
export function createTray(opts: {
  icon: string
  show: () => void
  disconnect: (id: string) => void
  quit: () => void
}): AppTray {
  let tray: Tray | null = null
  let state: AppState | null = null
  let notified = false

  const render = (): void => {
    if (!tray) return
    tray.setToolTip(tooltip(state))
    const activeId = state?.activeId ?? null
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Открыть SenAWG', click: opts.show },
        ...(activeId
          ? [{ label: 'Отключиться', enabled: !state?.busy, click: () => opts.disconnect(activeId) }]
          : []),
        { type: 'separator' },
        { label: 'Выход', click: opts.quit }
      ])
    )
  }

  return {
    update(next) {
      state = next
      render()
    },
    setEnabled(on) {
      if (on && !tray) {
        tray = new Tray(trayImage(opts.icon))
        tray.on('click', opts.show)
        tray.on('double-click', opts.show)
        render()
      } else if (!on && tray) {
        tray.destroy()
        tray = null
      }
    },
    notifyHidden() {
      if (!tray || notified) return
      notified = true
      tray.displayBalloon({
        title: 'SenAWG работает в фоне',
        content: 'Подключение не обрывается. Открыть или выйти — через значок у часов.'
      })
    },
    dispose() {
      tray?.destroy()
      tray = null
    }
  }
}
