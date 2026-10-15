import { useEffect, useState } from 'react'
import { MAX_SPLIT_DOMAINS, normalizeDomain, type SplitMode, type UiSettings } from '@shared/uiSettings'
import { isLinux, isMac } from '../lib/platform'

/** The platforms that can route by name at all (AppOptions.canSplitTunnel); asked once, false until known. */
export function useCanSplit(): boolean {
  const [can, setCan] = useState(false)
  useEffect(() => {
    let alive = true
    void window.awg.getAppOptions().then(
      (options) => alive && setCan(options.canSplitTunnel),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [])
  return can
}

const MODES: { value: SplitMode; label: string; hint?: string }[] = [
  { value: 'off', label: 'Всё через VPN' },
  { value: 'exclude', label: 'Всё, кроме сайтов из списка', hint: 'эти сайты открываются напрямую, мимо VPN' },
  { value: 'include', label: 'Только сайты из списка', hint: 'через VPN идут только они, остальное — напрямую' }
]

/** One site per line (commas and spaces work too); what is not a site is returned apart, so the form can point at it. */
function parseDomains(text: string): { domains: string[]; bad: string[] } {
  const domains = new Set<string>()
  const bad: string[] = []
  for (const word of text.split(/[\s,;]+/).filter(Boolean)) {
    const d = normalizeDomain(word)
    if (d) domains.add(d)
    else bad.push(word)
  }
  return { domains: [...domains], bad }
}

/**
 * «Что идёт через VPN»: the mode and the list of sites for it, the same in Настройки and in the dialog on the
 * main screen. The list is saved only while every line is a site; the other mode's list is kept as it was.
 */
export function SplitEditor({ settings, onChange, idPrefix }: {
  settings: UiSettings
  onChange: (patch: Partial<UiSettings>) => void
  /** Two editors may be on the page at once (the dialog over Настройки). */
  idPrefix: string
}): React.JSX.Element {
  const mode = settings.splitMode
  const saved = mode === 'include' ? settings.splitInclude : settings.splitExclude
  const [draft, setDraft] = useState(saved.join('\n'))
  // The list belongs to the mode: switching modes shows that mode's own list.
  const [draftMode, setDraftMode] = useState(mode)
  if (draftMode !== mode) {
    setDraftMode(mode)
    setDraft(saved.join('\n'))
  }

  const { domains, bad } = parseDomains(draft)
  const tooMany = domains.length > MAX_SPLIT_DOMAINS
  const key = mode === 'include' ? 'splitInclude' : 'splitExclude'
  const edit = (text: string): void => {
    setDraft(text)
    const next = parseDomains(text)
    if (next.bad.length === 0 && next.domains.length <= MAX_SPLIT_DOMAINS && mode !== 'off') onChange({ [key]: next.domains })
  }
  const listId = `${idPrefix}-list`

  return (
    <>
      <div className="choices">
        {MODES.map((o) => (
          <label key={o.value} className="choice sl">
            <input type="radio" name={`${idPrefix}-mode`} value={o.value} checked={mode === o.value} onChange={() => onChange({ splitMode: o.value })} />
            <span className="choice-text">
              <span>{o.label}</span>
              {o.hint && <span className="hint">{o.hint}</span>}
            </span>
          </label>
        ))}
      </div>
      {mode !== 'off' && (
        <div className="dns-fields">
          <label className="field" htmlFor={listId}>
            <span className="field-label">{mode === 'include' ? 'Сайты через VPN' : 'Сайты напрямую'}</span>
            <textarea
              id={listId}
              className="input mono split-list"
              rows={6}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={'example.com\nbank.ru'}
              value={draft}
              aria-invalid={bad.length > 0 || tooMany || undefined}
              aria-describedby={`${listId}-note`}
              onChange={(e) => edit(e.target.value)}
            />
            <span id={`${listId}-note`} className={bad.length > 0 || tooMany ? 'form-error' : 'hint'}>
              {bad.length > 0
                ? `Не похоже на сайт: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`
                : tooMany
                  ? `Не больше ${MAX_SPLIT_DOMAINS} сайтов`
                  : domains.length === 0
                    ? 'Пока список пуст — всё идёт через VPN'
                    : `Сайтов в списке: ${domains.length}`}
            </span>
          </label>
        </div>
      )}
      {mode !== 'off' && (
        <p className="hint">
          Работает, пока программы спрашивают адреса у системного DNS: если в браузере включён «Безопасный DNS» (DNS поверх HTTPS), правила не сработают.
          {!isMac && !isLinux && ' В этом режиме блокировка трафика вне VPN (kill switch) не действует.'}
        </p>
      )}
    </>
  )
}
