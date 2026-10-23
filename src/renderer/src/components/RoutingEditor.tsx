import { useEffect, useRef, useState } from 'react'
import { ROUTING_EXAMPLES } from '@shared/routingExamples'
import {
  MAX_ADVANCED_RULES,
  MAX_ROUTING_NAME,
  MAX_ROUTING_RULES,
  RULE_PREFIXES,
  asAdvanced,
  asLists,
  inertRouting,
  parseRouting,
  parseRoutingText,
  resolveRouting,
  sanitizeRouting,
  unsupportedRules,
  type AdvancedRule,
  type RouteAction,
  type RoutingCapabilities,
  type RoutingSettings
} from '@shared/routingRules'
import type { UiSettings } from '@shared/uiSettings'
import { isLinux, isMac } from '../lib/platform'
import { Dialog } from './Dialog'
import { Button, IconButton, Switch } from './ui'

/** What this platform's service can do with routing, once known; null until then. */
export function useRoutingOptions(): { can: boolean; caps: RoutingCapabilities } | null {
  const [state, setState] = useState<{ can: boolean; caps: RoutingCapabilities } | null>(null)
  useEffect(() => {
    let alive = true
    void window.awg.getAppOptions().then(
      (o) => alive && setState({ can: o.canSplitTunnel, caps: { process: o.canRouteByApp, ruleset: false } }),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [])
  return state
}

const ACTIONS: { value: RouteAction; label: string }[] = [
  { value: 'proxy', label: 'Через VPN' },
  { value: 'direct', label: 'Напрямую' },
  { value: 'block', label: 'Блокировать' }
]

/** The two lists of the first page, a tab each; «Блокировать» is only under them, while it has lines. */
const TABS: { key: 'proxy' | 'direct'; label: string; empty: string; placeholder: string }[] = [
  { key: 'proxy', label: 'Через VPN', empty: 'Эти сайты и сети идут через туннель', placeholder: 'youtube.com\nip:203.0.113.0/24' },
  { key: 'direct', label: 'В обход VPN', empty: 'Эти сайты и сети идут напрямую, мимо туннеля', placeholder: 'ozon.ru\ngosuslugi.ru' }
]

type Edit = (change: (r: RoutingSettings) => RoutingSettings) => void

/**
 * «Маршрутизация», as on Android: two tabs, «Через VPN» and «В обход VPN», each its own list of sites (and on Linux of
 * programs), both in force at once, and «Всё остальное» for the rest; «Продвинутые» opens rules in order, put in force by
 * their switch. What is not in force is shown dimmed and not changed, and switching keeps both. Unlike on Android it
 * can be changed while the VPN is on: it applies on the next connect. It lives in the dialog of the main screen's chip, as on
 * Android under the ring; Настройки have none. What is typed is kept as typed; it is saved only while every line parses, so a half-typed
 * line never reaches the helper.
 */
export function RoutingEditor({ settings, onChange, idPrefix, caps }: {
  settings: UiSettings
  onChange: (patch: Partial<UiSettings>) => void
  /** The ids of the editor's fields are made from it. */
  idPrefix: string
  caps: RoutingCapabilities
}): React.JSX.Element {
  const [draft, setDraft] = useState<RoutingSettings>(settings.routing)
  const [open, setOpen] = useState(false)
  const [help, setHelp] = useState(false)
  const top = useRef<HTMLDivElement>(null)
  const rulesOn = draft.mode === 'rules'
  const inert = inertRouting(resolveRouting(draft, caps))

  const edit: Edit = (change) => {
    const next = change(draft)
    setDraft(next)
    const clean = sanitizeRouting(next)
    if (clean) onChange({ routing: clean })
  }

  // The other page starts at its top, wherever the person had scrolled this one to.
  const go = (next: boolean): void => {
    setOpen(next)
    top.current?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <>
      <div ref={top} />
      {!open ? (
        <div className="dns-fields">
          {rulesOn && <p className="form-error">Сейчас действуют продвинутые правила, эти списки не применяются. Выключить их — в «Продвинутых».</p>}
          <ListTabs draft={draft} edit={edit} idPrefix={idPrefix} caps={caps} off={rulesOn} />
        </div>
      ) : (
        <div className="dns-fields">
          <Button className="routing-back" variant="text" icon="chevron" onClick={() => go(false)}>
            Списки
          </Button>
          <label className="choice sl">
            <Switch checked={rulesOn} onChange={(on) => edit((r) => (on ? asAdvanced(r) : asLists(r)))} />
            <span className="choice-text">
              <span>Использовать продвинутые правила</span>
              <span className="hint">{rulesOn ? 'Списки «Через VPN» и «В обход VPN» сейчас не применяются' : 'Сейчас действуют списки «Через VPN» и «В обход VPN»'}</span>
            </span>
          </label>
          {/* Off: the rules the switch would put in force, dimmed; with the lists in force, the ones they would start from. */}
          <AdvancedRules draft={asAdvanced(draft)} edit={(change) => edit((r) => change(asAdvanced(r)))} idPrefix={idPrefix} caps={caps} off={!rulesOn} />
        </div>
      )}

      <div className="dns-fields">
        {inert && (
          <p className="form-error" role="status">
            {inert === 'proxy'
              ? 'Сейчас правила ничего не меняют: всё остальное тоже идёт через VPN. Чтобы через VPN шло только то, что в правилах, выберите «Всё остальное: Напрямую».'
              : 'Сейчас правила ничего не меняют: всё остальное тоже идёт напрямую, и VPN не используется. Выберите «Всё остальное: Через VPN» или добавьте правила «Через VPN».'}
          </p>
        )}
        <p className="hint">
          Работает, пока программы спрашивают адреса у системного DNS: если в браузере включён «Безопасный DNS» (DNS поверх HTTPS), правила по сайтам не сработают.
          {!isMac && !isLinux && ' С правилами блокировка трафика вне VPN (kill switch) не действует.'}
        </p>
        <div className="routing-foot">
          {open ? (
            <Button variant="text" icon="info" onClick={() => setHelp(true)}>
              Как писать правила
            </Button>
          ) : (
            <Button className="routing-forward" variant="tonal" icon="chevron" onClick={() => go(true)}>
              Продвинутые
            </Button>
          )}
        </div>
      </div>

      {help && <RoutingHelp onClose={() => setHelp(false)} />}
    </>
  )
}

interface PartProps {
  draft: RoutingSettings
  edit: Edit
  idPrefix: string
  caps: RoutingCapabilities
  /** Not in force: shown dimmed, not changed. */
  off: boolean
}

/** What to say under a list of lines: the first error, else what will not be applied here, else a count. */
function listNote(text: string, action: RouteAction, caps: RoutingCapabilities, fallback: string): { text: string; error: boolean } {
  const { rules, errors } = parseRoutingText(text, action)
  if (errors.length) {
    return { text: `Строка ${errors[0].line}: ${errors[0].message}${errors.length > 1 ? ` (ещё ошибок: ${errors.length - 1})` : ''}`, error: true }
  }
  const warned = unsupportedRules(rules, caps)
  if (warned.length) {
    return { text: `Не применится: ${warned[0].rule.kind}:${warned[0].rule.value} — ${warned[0].reason}${warned.length > 1 ? ` (и ещё ${warned.length - 1})` : ''}`, error: false }
  }
  return { text: rules.length ? `Правил: ${rules.length}` : fallback, error: false }
}

const PROCESS_LINE = /^\s*processName:\s*(\S+)\s*$/i

/** A list's lines split into what the field shows (sites, notes) and the programs (`processName:`), which are listed apart. */
function splitApps(text: string): { sites: string; apps: string[] } {
  const lines = text.split('\n')
  const apps = [...new Set(lines.flatMap((l) => PROCESS_LINE.exec(l)?.[1] ?? []))]
  return { sites: lines.filter((l) => !PROCESS_LINE.test(l)).join('\n'), apps }
}

/** Back into one list: the sites exactly as typed (a line just begun stays), the programs after them. */
function joinApps(sites: string, apps: string[]): string {
  return [...(sites ? [sites] : []), ...apps.map((a) => `processName:${a}`)].join('\n')
}

/**
 * The two lists, a tab each, and «Всё остальное». These are the lists of «Продвинутые» (proxy and direct) as they are;
 * the first change turns «Простой» into them. A block list, which only the rules start, is shown under them while it
 * has lines. On Linux the programs of a list are a list of their own under its sites.
 */
function ListTabs({ draft, edit, idPrefix, caps, off }: PartProps): React.JSX.Element {
  const [tab, setTab] = useState<'proxy' | 'direct'>('proxy')
  const shown = asLists(draft)
  const current = TABS.find((t) => t.key === tab) ?? TABS[0]
  const change: Edit = (c) => edit((r) => c(asLists(r)))
  const setList = (c: (text: string) => string): void => change((r) => ({ ...r, [tab]: c(r[tab]) }))
  // Elsewhere processName: is only a line that will not apply, so it stays in the field and says so.
  const { sites, apps } = caps.process ? splitApps(shown[tab]) : { sites: shown[tab], apps: [] }
  const id = `${idPrefix}-${tab}`
  const note = listNote(sites, tab, caps, current.empty)
  const total = (['proxy', 'direct', 'block'] as const).reduce((n, a) => n + parseRoutingText(shown[a], a).rules.length, 0)

  return (
    <>
      {/* The tabs only show a list: they work while the rest is dimmed. */}
      <div className="seg routing-seg" role="tablist" aria-label="Список">
        {TABS.map((t) => {
          const count = parseRoutingText(shown[t.key], t.key).rules.length
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`${idPrefix}-panel`}
              className={`seg-btn sl${tab === t.key ? ' seg-btn-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {count > 0 && <span className="routing-count">{count}</span>}
            </button>
          )
        })}
      </div>

      <fieldset id={`${idPrefix}-panel`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${tab}`} className={`routing-part${off ? ' routing-part-off' : ''}`} disabled={off}>
        <label className="field" htmlFor={id}>
          <span className="field-label">Сайты и сети, по одному в строке</span>
          <textarea
            key={id}
            id={id}
            className="input mono split-list"
            rows={7}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={current.placeholder}
            value={sites}
            aria-invalid={note.error || undefined}
            aria-describedby={`${id}-note`}
            onChange={(e) => setList((list) => joinApps(e.target.value, splitApps(list).apps))}
          />
          <span id={`${id}-note`} className={note.error ? 'form-error' : 'hint'}>
            {note.text}
          </span>
        </label>

        {caps.process && <Programs key={tab} apps={apps} idPrefix={id} onChange={(next) => setList((list) => joinApps(splitApps(list).sites, next))} />}

        {shown.block.trim() !== '' && (
          <label className="field" htmlFor={`${idPrefix}-block`}>
            <span className="field-label">Блокировать</span>
            <textarea
              id={`${idPrefix}-block`}
              className="input mono split-list"
              rows={4}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={shown.block}
              onChange={(e) => change((r) => ({ ...r, block: e.target.value }))}
            />
            <span className="hint">{listNote(shown.block, 'block', caps, '').text}</span>
          </label>
        )}

        <Final idPrefix={`${idPrefix}-lists`} value={shown.final} onChange={(final) => change((r) => ({ ...r, final }))} />
        {total > MAX_ROUTING_RULES && <span className="form-error">Не больше {MAX_ROUTING_RULES} правил на все списки</span>}
      </fieldset>
    </>
  )
}

/** Linux: the programs of a list, by the name of their executable, each with a way to take it off. */
function Programs({ apps, idPrefix, onChange }: { apps: string[]; idPrefix: string; onChange: (apps: string[]) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const typed = name.trim()
  const add = (): void => {
    if (!typed || /\s/.test(typed)) return
    if (!apps.includes(typed)) onChange([...apps, typed])
    setName('')
  }
  return (
    <div className="field">
      <span className="field-label" id={`${idPrefix}-apps`}>Программы</span>
      {apps.length > 0 && (
        <ul className="routing-apps" aria-labelledby={`${idPrefix}-apps`}>
          {apps.map((a) => (
            <li key={a} className="routing-app">
              <span className="mono">{a}</span>
              <IconButton icon="close" label={`Убрать ${a}`} onClick={() => onChange(apps.filter((x) => x !== a))} />
            </li>
          ))}
        </ul>
      )}
      <div className="routing-app-add">
        <input
          className="input mono"
          aria-labelledby={`${idPrefix}-apps`}
          autoComplete="off"
          spellCheck={false}
          placeholder="telegram-desktop"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button variant="tonal" icon="plus" disabled={!typed || /\s/.test(typed)} onClick={add}>
          Добавить
        </Button>
      </div>
      <span className="hint">Имя исполняемого файла, как в списке процессов; регистр важен.</span>
    </div>
  )
}

/** «Всё остальное»: where what no list or rule names goes. */
function Final({ idPrefix, value, onChange }: { idPrefix: string; value: RoutingSettings['final']; onChange: (v: RoutingSettings['final']) => void }): React.JSX.Element {
  return (
    <div className="field" role="radiogroup" aria-labelledby={`${idPrefix}-final`}>
      <span id={`${idPrefix}-final`} className="field-label">Всё остальное</span>
      <div className="choices">
        {FINALS.map((f) => (
          <label key={f.value} className="choice sl">
            <input type="radio" name={`${idPrefix}-final`} value={f.value} checked={value === f.value} onChange={() => onChange(f.value)} />
            <span className="choice-text">
              <span>{f.label}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}

const FINALS: { value: RoutingSettings['final']; label: string }[] = [
  { value: 'proxy', label: 'Через VPN' },
  { value: 'direct', label: 'Напрямую' }
]

/** «Продвинутые»: rules in the user's order, each with its own action; the first match wins. */
function AdvancedRules({ draft, edit, idPrefix, caps, off }: PartProps): React.JSX.Element {
  const rules = draft.rules
  const set = (i: number, patch: Partial<AdvancedRule>): void => edit((r) => ({ ...r, rules: r.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) }))
  const move = (i: number, by: -1 | 1): void =>
    edit((r) => {
      const next = r.rules.slice()
      ;[next[i], next[i + by]] = [next[i + by], next[i]]
      return { ...r, rules: next }
    })
  const add = (): void => edit((r) => ({ ...r, rules: [...r.rules, { name: `Правило ${r.rules.length + 1}`, action: 'proxy', lines: '', enabled: true }] }))
  const total = parseRouting(draft).rules.length

  return (
    <fieldset className={`routing-part${off ? ' routing-part-off' : ''}`} disabled={off}>
      <Final idPrefix={`${idPrefix}-rules`} value={draft.final} onChange={(final) => edit((r) => ({ ...r, final }))} />
      <label className="field" htmlFor={`${idPrefix}-name`}>
        <span className="field-label">Название набора</span>
        <input id={`${idPrefix}-name`} className="input" autoComplete="off" maxLength={MAX_ROUTING_NAME} value={draft.name} onChange={(e) => edit((r) => ({ ...r, name: e.target.value }))} />
      </label>
      <p className="hint">Правила проверяются сверху вниз: первое подходящее решает. То, чего нет ни в одном, идёт по пункту «Всё остальное».</p>
      {rules.length === 0 && <p className="hint">Правил пока нет.</p>}
      {rules.map((r, i) => {
        const id = `${idPrefix}-rule-${i}`
        const note = listNote(r.lines, r.action, caps, 'Одна строка — одно условие: suffix:example.com')
        return (
          <section key={i} className={`adv-rule${r.enabled ? '' : ' adv-rule-off'}`} aria-label={r.name}>
            <div className="adv-rule-head">
              <Switch checked={r.enabled} aria-label={`Применять правило «${r.name}»`} onChange={(enabled) => set(i, { enabled })} />
              <input
                className="input adv-rule-name"
                aria-label="Название правила"
                autoComplete="off"
                maxLength={MAX_ROUTING_NAME}
                value={r.name}
                onChange={(e) => set(i, { name: e.target.value })}
              />
              <IconButton icon="up" label="Выше" disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton icon="down" label="Ниже" disabled={i === rules.length - 1} onClick={() => move(i, 1)} />
              <IconButton icon="trash" label="Удалить правило" onClick={() => edit((x) => ({ ...x, rules: x.rules.filter((_, j) => j !== i) }))} />
            </div>
            <div className="seg adv-rule-seg" role="radiogroup" aria-label={`Действие правила «${r.name}»`}>
              {ACTIONS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  role="radio"
                  aria-checked={r.action === a.value}
                  className={`seg-btn sl${r.action === a.value ? ' seg-btn-active' : ''}`}
                  onClick={() => set(i, { action: a.value })}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <textarea
              id={id}
              className="input mono split-list adv-rule-lines"
              rows={4}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={caps.process ? 'suffix:example.com\nip:203.0.113.0/24\nprocessName:spotify' : 'suffix:example.com\nip:203.0.113.0/24'}
              aria-label={`Условия правила «${r.name}»`}
              aria-invalid={note.error || undefined}
              aria-describedby={`${id}-note`}
              value={r.lines}
              onChange={(e) => set(i, { lines: e.target.value })}
            />
            <span id={`${id}-note`} className={note.error ? 'form-error' : 'hint'}>
              {note.text}
            </span>
          </section>
        )
      })}
      {total > MAX_ROUTING_RULES && <span className="form-error">Не больше {MAX_ROUTING_RULES} условий на все правила</span>}
      <Button className="dns-reset" variant="tonal" icon="plus" disabled={off || rules.length >= MAX_ADVANCED_RULES} onClick={add}>
        Добавить правило
      </Button>
    </fieldset>
  )
}

const PREFIX_HELP: [string, string][] = [
  ['domain:', 'ровно это имя: domain:nura.eco'],
  ['suffix:', 'имя и все его поддомены: suffix:ozon.ru'],
  ['keyword:', 'часть имени: keyword:adservice'],
  ['regex:', 'регулярное выражение по имени: regex:\\.(ru|su)$'],
  ['ip:', 'адрес или сеть: ip:10.0.0.0/8'],
  ['processName:', 'программа по имени файла, только Linux: processName:spotify'],
  ['processPath:', 'программа по пути, только Linux: processPath:/usr/bin/spotify']
]

/** The syntax, the order and the limits, with the same examples as docs/routing.md. */
function RoutingHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Dialog
      title="Маршрутизация: как пользоваться"
      onClose={onClose}
      fluid
      actions={
        <Button variant="tonal" onClick={onClose}>
          Закрыть
        </Button>
      }
    >
      <p className="hint">
        Одно условие в строке, вида «префикс:значение». Строка без префикса — это сайт с поддоменами (suffix:); «#» начинает заметку.
      </p>
      <dl className="routing-help">
        {PREFIX_HELP.map(([prefix, text]) => (
          <div key={prefix}>
            <dt className="mono">{prefix}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <p className="hint">
        Списки проверяются по очереди: сначала «Через VPN», потом «В обход VPN», потом «Блокировать». «Продвинутые» — правила в вашем порядке, у каждого своё
        действие, его можно выключить, не удаляя; включённые, они заменяют списки. Побеждает первое совпавшее; всё, чего нет в правилах, идёт по пункту «Всё остальное». Сайты решаются при запросе адреса, поэтому правило по имени сильнее правила по сети. Заблокированные имена не
        открываются совсем. Допустимые префиксы: {RULE_PREFIXES.join(', ')}. Изменения применяются при следующем подключении.
      </p>
      <h3 className="routing-examples-title">Примеры</h3>
      {ROUTING_EXAMPLES.map((e) => (
        <details key={e.title} className="routing-example">
          <summary>{e.title}</summary>
          {e.note && <p className="hint">{e.note}</p>}
          <pre className="mono">
            {`Всё остальное: ${e.routing.final === 'direct' ? 'напрямую' : 'через VPN'}`}
            {e.routing.proxy && `\n\nЧерез VPN:\n${e.routing.proxy}`}
            {e.routing.direct && `\n\nВ обход VPN:\n${e.routing.direct}`}
            {e.routing.block && `\n\nБлокировать:\n${e.routing.block}`}
          </pre>
        </details>
      ))}
    </Dialog>
  )
}
