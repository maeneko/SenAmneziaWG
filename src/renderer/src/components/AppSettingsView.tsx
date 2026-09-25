import { useEffect, useState } from 'react'
import type { AppOptions, MacServiceInfo } from '@shared/types'
import type { UiSettings } from '@shared/uiSettings'
import { errorText } from '../lib/errors'
import { AboutView } from './AboutView'
import { Dialog } from './Dialog'
import { UpdateCard } from './UpdateCard'
import { Button, Switch } from './ui'

/**
 * «Приложение»: updates, the two switches that belong to the operating system rather than to the
 * application, what this build is, and — where there is anything to take apart — the way out of it. The switches read their state back
 * from the system instead of trusting what was asked, so a refusal below shows as the switch staying off.
 */
export function AppSettingsView({ settings, onChange, uninstallError, onUninstall }: {
  settings: UiSettings
  onChange: (patch: Partial<UiSettings>) => void
  /** Why the last removal did not go through; shown under «Удаление» until the next attempt. */
  uninstallError: string | null
  /** Confirmed: App puts the removal screen up and runs it. */
  onUninstall: (keepData: boolean) => void
}): React.JSX.Element {
  const [options, setOptions] = useState<AppOptions | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [removing, setRemoving] = useState(false)
  // Asked every time, answered «Да» in advance: losing the keys is the one thing here that cannot be undone.
  const [keepData, setKeepData] = useState(true)

  useEffect(() => {
    let alive = true
    void window.awg.getAppOptions().then(
      (next) => {
        if (alive) setOptions(next)
      },
      () => {
        /* the switch stays disabled until something is known about it */
      }
    )
    return () => {
      alive = false
    }
  }, [])

  const setAutoStart = (enabled: boolean): void => {
    setSaving(true)
    setFailed(false)
    void window.awg.setAutoStart(enabled).then(
      (autoStart) => {
        setOptions((prev) => (prev ? { ...prev, autoStart } : prev))
        setFailed(autoStart !== enabled)
        setSaving(false)
      },
      () => {
        setFailed(true)
        setSaving(false)
      }
    )
  }

  return (
    <>
      <UpdateCard
        api={window.awg.update}
        units={settings.units}
        automatic={settings.autoUpdate}
        onAutomatic={(autoUpdate) => onChange({ autoUpdate })}
      />

      <section className="settings-group" aria-labelledby="set-start">
        <h2 id="set-start" className="settings-title">Запуск</h2>
        <label className="choice sl">
          <Switch checked={options?.autoStart ?? false} disabled={options === null || saving} onChange={setAutoStart} />
          <span className="choice-text">
            <span>Запускать при входе в систему</span>
            <span className="hint">Окно откроется сразу после входа. Подключение при этом не включается само.</span>
          </span>
        </label>
        {failed && (
          <p className="form-error" role="alert">
            Система не дала изменить автозапуск. Так бывает, если это ограничено правилами компьютера.
          </p>
        )}

        {options?.canRunInBackground && (
          <label className="choice sl">
            <Switch checked={settings.runInBackground} onChange={(runInBackground) => onChange({ runInBackground })} />
            <span className="choice-text">
              <span>Работать в фоне</span>
              <span className="hint">
                Закрытое окно сворачивается в значок у часов, и подключение не обрывается. Выйти совсем — через меню
                значка.
              </span>
            </span>
          </label>
        )}

        <label className="choice sl">
          <Switch checked={settings.autoConnect} onChange={(autoConnect) => onChange({ autoConnect })} />
          <span className="choice-text">
            <span>Подключаться к последнему серверу</span>
            <span className="hint">
              Сразу после запуска поднимать тот сервер, которым пользовались в прошлый раз. Если в этот момент
              подключение уже есть, оно остаётся как было.
            </span>
          </span>
        </label>
      </section>

      <MacServiceSection />

      <AboutView />

      {options?.canUninstall && (
        <section className="settings-group" aria-labelledby="set-remove">
          <h2 id="set-remove" className="settings-title">Удаление</h2>
          <p className="hint">
            Снимет службу и сотрёт файлы программы, как обычное удаление приложения. Серверы и ключи можно
            сохранить — спросим перед удалением.
          </p>
          {uninstallError && (
            <p className="form-error" role="alert">
              {uninstallError}
            </p>
          )}
          <Button
            className="danger-action"
            variant="danger"
            icon="trash"
            onClick={() => {
              setKeepData(true)
              setRemoving(true)
            }}
          >
            Удалить SenAWG
          </Button>
        </section>
      )}

      {removing && (
        <Dialog
          title="Удалить SenAWG?"
          onClose={() => setRemoving(false)}
          actions={
            <>
              <Button variant="tonal" onClick={() => setRemoving(false)}>
                Отмена
              </Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={() => {
                  setRemoving(false)
                  onUninstall(keepData)
                }}
              >
                Удалить
              </Button>
            </>
          }
        >
          <p>
            Система спросит права администратора. После этого подключение оборвётся, программа будет удалена с
            компьютера, а затем закроется.
          </p>
          <fieldset className="keep">
            <legend>Сохранить серверы и ключи?</legend>
            <label className="keep-option sl">
              <input type="radio" name="keep-data" checked={keepData} onChange={() => setKeepData(true)} />
              <span className="keep-text">
                <span className="keep-title">Да, сохранить</span>
                <span className="hint">При новой установке серверы, ключи и настройки будут на месте.</span>
                <span className="keep-tag">Рекомендуем</span>
              </span>
            </label>
            <label className="keep-option sl">
              <input type="radio" name="keep-data" checked={!keepData} onChange={() => setKeepData(false)} />
              <span className="keep-text">
                <span className="keep-title">Нет, стереть</span>
                <span className="hint">Ключи удалятся с компьютера. Вернуть сервер можно будет только по новой ссылке vpn:// или sen://.</span>
              </span>
            </label>
          </fieldset>
        </Dialog>
      )}
    </>
  )
}

/** What the section says about the service, in the user's terms. */
function serviceState(info: MacServiceInfo): string {
  if (!info.installed) {
    return 'Не установлена. При первом подключении система один раз спросит пароль администратора, чтобы её поставить.'
  }
  const version = info.version ? `, версия ${info.version}` : ''
  if (info.current === false) {
    return `Установлена${version} — от прежней версии SenAWG. Обновится при следующем подключении: система один раз спросит пароль.`
  }
  return `Установлена${version}. VPN включается и выключается без пароля.`
}

/**
 * macOS: the SenAWG service (tunnel/macos/service.ts) — whether it is there, and the way to take it off.
 * Not shown where the app does not use one. Dragging SenAWG to the Trash leaves the service behind, so
 * this is also where it is removed before that.
 */
function MacServiceSection(): React.JSX.Element | null {
  const [info, setInfo] = useState<MacServiceInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): Promise<void> =>
    window.awg.getMacService().then(
      (next) => setInfo(next),
      () => setInfo(null)
    )

  useEffect(() => {
    let alive = true
    void window.awg.getMacService().then(
      (next) => {
        if (alive) setInfo(next)
      },
      () => {
        /* nothing known: the section stays hidden */
      }
    )
    return () => {
      alive = false
    }
  }, [])

  if (!info) return null

  const remove = (): void => {
    setBusy(true)
    setError(null)
    void window.awg
      .removeMacService()
      .then(
        () => refresh(),
        (err: unknown) => setError(errorText(err))
      )
      .finally(() => setBusy(false))
  }

  return (
    <section className="settings-group" aria-labelledby="set-service">
      <h2 id="set-service" className="settings-title">Служба SenAWG</h2>
      <p className="settings-text">{serviceState(info)}</p>
      {info.installed && (
        <>
          <p className="hint">
            Служба остаётся в системе, если просто перетащить SenAWG в Корзину. Перед удалением программы уберите её
            здесь. VPN при этом должен быть выключен.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button className="danger-action" variant="danger" icon="trash" disabled={busy} onClick={remove}>
            Удалить службу
          </Button>
        </>
      )}
    </section>
  )
}
