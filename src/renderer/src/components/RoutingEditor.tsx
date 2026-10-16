import { useEffect, useState } from 'react'
import { ROUTING_EXAMPLES } from '@shared/routingExamples'
import {
  MAX_ADVANCED_RULES,
  MAX_ROUTING_NAME,
  MAX_ROUTING_RULES,
  RULE_PREFIXES,
  listsFromSimple,
  parseRouting,
  parseRoutingText,
  parseSites,
  rulesFromLists,
  sanitizeRouting,
  unsupportedRules,
  type AdvancedRule,
  type RouteAction,
  type RoutingCapabilities,
  type RoutingMode,
  type RoutingSettings,
  type SimpleKind
} from '@shared/routingRules'
import type { UiSettings } from '@shared/uiSettings'
import { isLinux, isMac } from '../lib/platform'
import { Dialog } from './Dialog'
import { Button, IconButton, Select, Switch, type SelectOption } from './ui'

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

const FINALS: SelectOption<RoutingSettings['final']>[] = [
  { value: 'proxy', label: 'Через VPN' },
  { value: 'direct', label: 'Напрямую' }
]

const LISTS: { key: RouteAction; label: string; hint: string }[] = [
  { key: 'proxy', label: 'Через VPN', hint: 'Эти сайты и сети идут через туннель' },
  { key: 'direct', label: 'Напрямую', hint: 'Эти идут мимо туннеля' },
  { key: 'block', label: 'Блокировать', hint: 'Эти не открываются' }
]

const PLACEHOLDERS: Record<RouteAction, string> = {
  proxy: 'suffix:youtube.com\ndomain:nura.eco',
  direct: 'suffix:ozon.ru\nsuffix:ozone.ru',
  block: 'suffix:doubleclick.net\nkeyword:adservice'
}

/**
 * «Маршрутизация»: a name, where everything goes by default, and three lists of `prefix:value` lines, as in
 * Throne's simple rules. The same editor is in Настройки and in the dialog of the main screen's chip. What is
 * typed is kept as typed; it is saved only while every line parses, so a half-typed line never reaches the helper.
 */
const KINDS: { value: SimpleKind; label: string; hint: string }[] = [
  { value: 'except', label: 'Всё через VPN, кроме этих сайтов', hint: 'Эти сайты открываются напрямую, мимо VPN' },
  { value: 'only', label: 'Через VPN только эти сайты', hint: 'Остальное идёт напрямую' },
  { value: 'block', label: 'Блокировать эти сайты', hint: 'Они не открываются совсем, остальное идёт через VPN' }
]

const ACTIONS: SelectOption<RouteAction>[] = [
  { value: 'proxy', label: 'Через VPN' },
  { value: 'direct', label: 'Напрямую' },
  { value: 'block', label: 'Блокировать' }
]

/**
 * «Маршрутизация»: «Простой» is only sites (one list, one choice of what to do with them); «Продвинутый» is Throne's:
 * a name, where everything goes by default, and either three lists of `prefix:value` lines (Списки: Throne's Basic tab)
 * or rules in your own order (По порядку: its Advanced tab). The same editor is in Настройки and in the dialog of the
 * main screen's chip. What is typed is kept as typed; it is saved only while every line parses, so a half-typed line
 * never reaches the helper.
 */
export function RoutingEditor({ settings, onChange, idPrefix, caps }: {
  settings: UiSettings
  onChange: (patch: Partial<UiSettings>) => void
  /** Two editors may be on the page at once (the dialog over Настройки). */
  idPrefix: string
  caps: RoutingCapabilities
}): React.JSX.Element {
  const [draft, setDraft] = useState<RoutingSettings>(settings.routing)
  const [help, setHelp] = useState(false)
  const advanced = draft.mode !== 'simple'

  const edit = (patch: Partial<RoutingSettings>): void => {
    const next = { ...draft, ...patch }
    setDraft(next)
    const clean = sanitizeRouting(next)
    if (clean) onChange({ routing: clean })
  }

  // Going over to «Продвинутый» for the first time carries the sites along, as lines of the list their kind names.
  const pickAdvanced = (): void => edit({ mode: 'lists', ...(listsFromSimple(draft) ?? {}) })
  // The rules start from the three lists, so going over loses nothing.
  const pickView = (mode: 'lists' | 'rules'): void => edit(mode === 'rules' && draft.rules.length === 0 ? { mode, rules: rulesFromLists(draft) } : { mode })

  return (
    <>
      <div className="dns-fields">
        <div className="seg routing-seg" role="tablist" aria-label="Режим маршрутизации">
          <button type="button" role="tab" aria-selected={!advanced} className={`seg-btn sl${!advanced ? ' seg-btn-active' : ''}`} onClick={() => edit({ mode: 'simple' })}>
            Простой
          </button>
          <button type="button" role="tab" aria-selected={advanced} className={`seg-btn sl${advanced ? ' seg-btn-active' : ''}`} onClick={advanced ? undefined : pickAdvanced}>
            Продвинутый
          </button>
        </div>
      </div>

      {!advanced ? (
        <div className="dns-fields">
          <SimpleSites draft={draft} edit={edit} idPrefix={idPrefix} />
          <Button className="dns-reset" variant="tonal" onClick={() => setHelp(true)}>
            Как пользоваться
          </Button>
        </div>
      ) : (
        <>
          <div className="dns-fields">
            <div className="seg routing-seg routing-seg-sub" role="tablist" aria-label="Вид продвинутого режима">
              {(['lists', 'rules'] as const).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={draft.mode === m} className={`seg-btn sl${draft.mode === m ? ' seg-btn-active' : ''}`} onClick={() => pickView(m)}>
                  {m === 'lists' ? 'Списки' : 'По порядку'}
                </button>
              ))}
            </div>
            <label className="field" htmlFor={`${idPrefix}-name`}>
              <span className="field-label">Название</span>
              <input id={`${idPrefix}-name`} className="input" autoComplete="off" maxLength={MAX_ROUTING_NAME} value={draft.name} onChange={(e) => edit({ name: e.target.value })} />
            </label>
            <div className="field">
              <span id={`${idPrefix}-final-label`} className="field-label">Всё остальное</span>
              <Select id={`${idPrefix}-final`} aria-labelledby={`${idPrefix}-final-label`} value={draft.final} options={FINALS} onChange={(final) => edit({ final })} />
            </div>
          </div>
          <div className="dns-fields">
            {draft.mode === 'lists' ? (
              <SimpleLists draft={draft} edit={edit} idPrefix={idPrefix} caps={caps} />
            ) : (
              <AdvancedRules draft={draft} edit={edit} idPrefix={idPrefix} caps={caps} />
            )}
            <Button className="dns-reset" variant="tonal" onClick={() => setHelp(true)}>
              Как пользоваться
            </Button>
          </div>
        </>
      )}

      <p className="hint">
        Работает, пока программы спрашивают адреса у системного DNS: если в браузере включён «Безопасный DNS» (DNS поверх HTTPS), правила не сработают.
        {!isMac && !isLinux && ' В этом режиме блокировка трафика вне VPN (kill switch) не действует.'}
      </p>

      {help && <RoutingHelp onClose={() => setHelp(false)} />}
    </>
  )
}

interface PartProps {
  draft: RoutingSettings
  edit: (patch: Partial<RoutingSettings>) => void
  idPrefix: string
  caps: RoutingCapabilities
}

/** «Простой»: what to do, and the sites to do it with. */
function SimpleSites({ draft, edit, idPrefix }: Omit<PartProps, 'caps'>): React.JSX.Element {
  const { sites, errors } = parseSites(draft.simple.sites)
  const id = `${idPrefix}-sites`
  const note = errors.length
    ? { error: true, text: `Строка ${errors[0].line}: ${errors[0].message}${errors.length > 1 ? ` (ещё ошибок: ${errors.length - 1})` : ''}` }
    : { error: false, text: sites.length ? `Сайтов в списке: ${sites.length}` : 'Пока список пуст — всё идёт через VPN' }
  return (
    <>
      <div className="choices">
        {KINDS.map((k) => (
          <label key={k.value} className="choice sl">
            <input type="radio" name={`${idPrefix}-kind`} value={k.value} checked={draft.simple.kind === k.value} onChange={() => edit({ simple: { ...draft.simple, kind: k.value } })} />
            <span className="choice-text">
              <span>{k.label}</span>
              <span className="hint">{k.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <label className="field" htmlFor={id}>
        <span className="field-label">Сайты</span>
        <textarea
          id={id}
          className="input mono split-list"
          rows={7}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={'ozon.ru\nyoutube.com'}
          value={draft.simple.sites}
          aria-invalid={note.error || undefined}
          aria-describedby={`${id}-note`}
          onChange={(e) => edit({ simple: { ...draft.simple, sites: e.target.value } })}
        />
        <span id={`${id}-note`} className={note.error ? 'form-error' : 'hint'}>
          {note.text}
        </span>
      </label>
      <p className="hint">По одному сайту в строке, можно ссылкой. Поддомены входят сами: «ozon.ru» покрывает и «www.ozon.ru».</p>
    </>
  )
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

/** «Списки»: the three lists, matched proxy, direct, block (Throne's Basic tab). */
function SimpleLists({ draft, edit, idPrefix, caps }: PartProps): React.JSX.Element {
  const total = LISTS.reduce((n, l) => n + parseRoutingText(draft[l.key], l.key).rules.length, 0)
  return (
    <>
      <div className="routing-grid">
        {LISTS.map((l) => {
          const id = `${idPrefix}-${l.key}`
          const note = listNote(draft[l.key], l.key, caps, l.hint)
          return (
            <label key={l.key} className="field" htmlFor={id}>
              <span className="field-label">{l.label}</span>
              <textarea
                id={id}
                className="input mono split-list"
                rows={7}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={PLACEHOLDERS[l.key]}
                value={draft[l.key]}
                aria-invalid={note.error || undefined}
                aria-describedby={`${id}-note`}
                onChange={(e) => edit({ [l.key]: e.target.value })}
              />
              <span id={`${id}-note`} className={note.error ? 'form-error' : 'hint'}>
                {note.text}
              </span>
            </label>
          )
        })}
      </div>
      {total > MAX_ROUTING_RULES && <span className="form-error">Не больше {MAX_ROUTING_RULES} правил на все списки</span>}
    </>
  )
}

/** «Продвинутый»: rules in the user's order, each with its own action; the first match wins. */
function AdvancedRules({ draft, edit, idPrefix, caps }: PartProps): React.JSX.Element {
  const rules = draft.rules
  const set = (i: number, patch: Partial<AdvancedRule>): void => edit({ rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const move = (i: number, by: -1 | 1): void => {
    const next = rules.slice()
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    edit({ rules: next })
  }
  const add = (): void => edit({ rules: [...rules, { name: `Правило ${rules.length + 1}`, action: 'proxy', lines: '', enabled: true }] })
  const total = parseRouting(draft).rules.length

  return (
    <>
      <p className="hint">Правила проверяются сверху вниз, побеждает первое совпавшее. То, чего нет ни в одном, идёт по пункту «Всё остальное».</p>
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
              <div className="adv-rule-action">
                <Select id={`${id}-action`} aria-labelledby={`${id}-head`} value={r.action} options={ACTIONS} onChange={(action) => set(i, { action })} />
              </div>
              <IconButton icon="up" label="Выше" disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton icon="down" label="Ниже" disabled={i === rules.length - 1} onClick={() => move(i, 1)} />
              <IconButton icon="trash" label="Удалить правило" onClick={() => edit({ rules: rules.filter((_, j) => j !== i) })} />
            </div>
            <span id={`${id}-head`} className="visually-hidden">Действие правила «{r.name}»</span>
            <textarea
              id={id}
              className="input mono split-list adv-rule-lines"
              rows={4}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
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
      <Button className="dns-reset" variant="tonal" icon="plus" disabled={rules.length >= MAX_ADVANCED_RULES} onClick={add}>
        Добавить правило
      </Button>
    </>
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
        «Простой» режим — только сайты: список и выбор, что с ними делать. «Продвинутый» — как в Throne: списки «Через VPN», «Напрямую», «Блокировать» или
        правила по порядку, строки вида «префикс:значение». Строка без префикса — это сайт с поддоменами (suffix:); «#» начинает комментарий.
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
        «Списки» проверяются как в Throne: сначала «Через VPN», потом «Напрямую», потом «Блокировать». «По порядку» — правила в вашем порядке, у каждого своё
        действие, его можно выключить, не удаляя. В обоих побеждает первое совпавшее; всё, чего нет в правилах, идёт по пункту «Всё остальное». Сайты решаются при запросе адреса, поэтому правило по имени сильнее правила по сети. Заблокированные имена не
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
            {e.routing.direct && `\n\nНапрямую:\n${e.routing.direct}`}
            {e.routing.block && `\n\nБлокировать:\n${e.routing.block}`}
          </pre>
        </details>
      ))}
    </Dialog>
  )
}
