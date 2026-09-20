import { useEffect, useState } from 'react'
import type { AppOptions } from '@shared/types'
import type { UiSettings } from '@shared/uiSettings'
import { Dialog } from './Dialog'
import { Button } from './ui'

/**
 * «Приложение»: the two switches that belong to the operating system rather than to the application,
 * and — where there is anything to take apart — the way out of it. The switches read their state back
 * from the system instead of trusting what was asked, so a refusal below shows as the switch staying off.
 */
export function AppSettingsView({ settings, onChange }: {
  settings: UiSettings
  onChange: (patch: Partial<UiSettings>) => void
}): React.JSX.Element {
  const [options, setOptions] = useState<AppOptions | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [removing, setRemoving] = useState(false)

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
      <section className="settings-group" aria-labelledby="set-start">
        <h2 id="set-start" className="settings-title">Запуск</h2>
        <label className="choice sl">
          <input
            type="checkbox"
            checked={options?.autoStart ?? false}
            disabled={options === null || saving}
            onChange={(e) => setAutoStart(e.target.checked)}
          />
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

        <label className="choice sl">
          <input type="checkbox" checked={settings.autoConnect} onChange={(e) => onChange({ autoConnect: e.target.checked })} />
          <span className="choice-text">
            <span>Подключаться к последнему серверу</span>
            <span className="hint">
              Сразу после запуска поднимать тот сервер, которым пользовались в прошлый раз. Если в этот момент
              подключение уже есть, оно остаётся как было.
            </span>
          </span>
        </label>
      </section>

      {options?.canUninstall && (
        <section className="settings-group" aria-labelledby="set-remove">
          <h2 id="set-remove" className="settings-title">Удаление</h2>
          <p className="hint">
            То же самое, что «Удалить» в «Установленных приложениях» Windows: снимет службу, сотрёт файлы
            программы и её служебную папку. Ваши серверы и ключи останутся на диске.
          </p>
          <Button className="danger-action" variant="danger" icon="trash" onClick={() => setRemoving(true)}>
            Удалить AmnesiaWG
          </Button>
        </section>
      )}

      {removing && (
        <Dialog
          title="Удалить AmnesiaWG?"
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
                  void window.awg.uninstall()
                }}
              >
                Удалить
              </Button>
            </>
          }
        >
          <p>
            Windows спросит права администратора. После этого подключение оборвётся, программа закроется и будет
            удалена с компьютера. Ваши серверы и ключи останутся — при новой установке они будут на месте.
          </p>
        </Dialog>
      )}
    </>
  )
}
