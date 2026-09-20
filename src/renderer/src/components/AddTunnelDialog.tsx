import { useRef, useState } from 'react'
import type { Tunnel } from '@shared/types'
import { useLinkPreview } from '../hooks/useLinkPreview'
import { errorText } from '../lib/errors'
import { Dialog } from './Dialog'
import { KeyField } from './KeyField'
import { Button } from './ui'

/** Same key field as the first-run screen: paste a vpn:// key, see its server, add it. */
export function AddTunnelDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (t: Tunnel) => void }): React.JSX.Element {
  const [link, setLink] = useState('')
  const preview = useLinkPreview(link)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const valid = preview?.ok === true
  const addButton = useRef<HTMLButtonElement>(null)

  async function save(): Promise<void> {
    if (!valid || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await window.awg.importLink(link)
      if (result.ok) onAdded(result.tunnel)
      else setSaveError(result.error)
    } catch (e) {
      setSaveError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="Добавить сервер"
      onClose={onClose}
      actions={
        <>
          <Button variant="tonal" onClick={onClose}>
            Отмена
          </Button>
          <Button ref={addButton} icon="plus" disabled={!valid || saving} onClick={() => void save()}>
            Добавить
          </Button>
        </>
      }
    >
      <KeyField
        id="vpn-link"
        link={link}
        onLink={(value) => {
          setLink(value)
          setSaveError(null)
        }}
        preview={preview}
        error={saveError ?? (preview?.ok === false ? preview.error : null)}
        locked={saving}
        onSubmit={() => void save()}
        // The field leaves with the focus in it: give it to «Добавить», so Enter still adds.
        onFace={(face) => face === 'server' && requestAnimationFrame(() => addButton.current?.focus())}
        autoFocus
      />
    </Dialog>
  )
}
