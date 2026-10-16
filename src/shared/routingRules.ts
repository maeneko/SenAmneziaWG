import { normalizeDomain, parseIpOrCidr } from './netNames'

/**
 * Routing rules in the form of Throne's «simple rules»: three lists of `prefix:value` lines, one list per
 * action, and a default for everything no line names. What a rule can say is bounded by what the helper does
 * with it (helper/internal/proto/routing.go repeats these checks: the text comes from an unprivileged
 * process and ends up in a root service).
 */

export type RouteAction = 'proxy' | 'direct' | 'block'
export type RuleKind = 'domain' | 'suffix' | 'keyword' | 'regex' | 'ip' | 'ruleset' | 'processName' | 'processPath'

export interface RoutingRule {
  action: RouteAction
  kind: RuleKind
  value: string
}

/**
 * Three ways to say the same thing. «Простой»: only sites, one list and one choice of what to do with them.
 * «Продвинутый» has two views, as Throne does: `lists` (Throne's Basic tab: three lists of `prefix:value` lines,
 * matched proxy, direct, block) and `rules` (Throne's Advanced tab: rules in the user's own order, each with an
 * action, the first match wins). All three are kept, so going back and forth loses nothing; `mode` says which one
 * is in force.
 */
export type RoutingMode = 'simple' | 'lists' | 'rules'

/** What «Простой» does with its sites: only they go through the VPN, everything but them does, or they are blocked. */
export type SimpleKind = 'only' | 'except' | 'block'

export interface SimpleRouting {
  kind: SimpleKind
  /** One site per line, as typed (a link is fine, the site is taken from it). */
  sites: string
}

/** One rule of the `rules` view: a name, an action and lines, as typed. */
export interface AdvancedRule {
  name: string
  action: RouteAction
  lines: string
  /** Off: kept in the list, not applied. */
  enabled: boolean
}

/** What is stored: the lists as the user typed them, comments and all. */
export interface RoutingSettings {
  name: string
  mode: RoutingMode
  simple: SimpleRouting
  /** Where everything no line names goes (`lists` and `rules`; «Простой» has it in its kind). */
  final: 'direct' | 'proxy'
  direct: string
  proxy: string
  block: string
  rules: AdvancedRule[]
}

/** What the helper gets: the default and the rules in the order they are matched (proxy, direct, block). */
export interface RoutingConfig {
  final: 'direct' | 'proxy'
  rules: RoutingRule[]
}

export const ROUTING_DEFAULTS: RoutingSettings = {
  name: 'Default',
  mode: 'simple',
  simple: { kind: 'except', sites: '' },
  final: 'proxy',
  direct: '',
  proxy: '',
  block: '',
  rules: []
}

/** The same caps the helper enforces. */
export const MAX_ROUTING_RULES = 2000
export const MAX_ROUTING_TEXT = 200_000
export const MAX_ROUTING_NAME = 64
/** How many rules the advanced mode may hold (each has any number of lines; MAX_ROUTING_RULES counts the lines). */
export const MAX_ADVANCED_RULES = 100

const KINDS: Record<string, RuleKind> = {
  domain: 'domain',
  suffix: 'suffix',
  keyword: 'keyword',
  regex: 'regex',
  ip: 'ip',
  ruleset: 'ruleset',
  processname: 'processName',
  processpath: 'processPath'
}

export const RULE_PREFIXES: readonly string[] = ['domain', 'suffix', 'keyword', 'regex', 'ip', 'ruleset', 'processName', 'processPath']

export interface LineIssue {
  /** 1-based, in the list the line is in. */
  line: number
  text: string
  message: string
}

const CONTROL = /[\u0000-\u001f\u007f]/
const KEYWORD = /^[a-z0-9._-]{2,63}$/
const RULESET = /^(?:(?:geoip|geosite)-[a-z0-9._-]{1,80}|https:\/\/[^\s]{1,500})$/i

type Parsed = { ok: true; kind: RuleKind; value: string } | { ok: false; message: string }

function parseValue(kind: RuleKind, value: string): Parsed {
  switch (kind) {
    case 'domain':
    case 'suffix': {
      const d = normalizeDomain(value)
      return d ? { ok: true, kind, value: d } : { ok: false, message: 'Не похоже на доменное имя (нужно хотя бы две части, например example.com)' }
    }
    case 'keyword': {
      const k = value.toLowerCase()
      return KEYWORD.test(k) ? { ok: true, kind, value: k } : { ok: false, message: 'Ключевое слово: 2–63 символа из a–z, 0–9, точки, дефиса и подчёркивания' }
    }
    case 'regex': {
      if (!value || value.length > 256 || CONTROL.test(value)) return { ok: false, message: 'Регулярное выражение: до 256 символов' }
      // The helper uses RE2: no lookaround, no back-references.
      if (/\(\?(?:=|!|<=|<!)/.test(value) || /\\[1-9]/.test(value)) return { ok: false, message: 'Регулярное выражение без просмотра вперёд/назад и обратных ссылок (движок RE2)' }
      try {
        new RegExp(value)
      } catch {
        return { ok: false, message: 'Некорректное регулярное выражение' }
      }
      return { ok: true, kind, value }
    }
    case 'ip': {
      const r = parseIpOrCidr(value)
      return r.ok ? { ok: true, kind, value: r.value } : { ok: false, message: r.error }
    }
    case 'ruleset':
      return RULESET.test(value) ? { ok: true, kind, value: value.startsWith('https') ? value : value.toLowerCase() } : { ok: false, message: 'Набор: geoip-ru, geosite-ru или ссылка https://…' }
    case 'processName':
      if (!value || value.length > 255 || CONTROL.test(value) || /[\\/]/.test(value)) return { ok: false, message: 'Имя процесса — имя исполняемого файла без пути (spotify, Telegram)' }
      return { ok: true, kind, value }
    case 'processPath':
      if (!/^(?:\/|[A-Za-z]:\\)/.test(value) || value.length > 4096 || CONTROL.test(value)) return { ok: false, message: 'Путь к программе — полный, например /usr/bin/spotify' }
      return { ok: true, kind, value }
  }
}

/** One line: a rule, or nothing (blank, comment), or why it is refused. */
export function parseRoutingLine(raw: string): { rule: { kind: RuleKind; value: string } | null; error?: string } {
  const line = raw.trim()
  if (!line || line.startsWith('#')) return { rule: null }
  const colon = line.indexOf(':')
  const prefix = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : ''
  let kind: RuleKind | undefined = KINDS[prefix]
  let value = kind ? line.slice(colon + 1).trim() : line
  if (!kind) {
    if (colon > 0) {
      // «2001:db8::/32» without «ip:» lands here too; say what is accepted rather than guess.
      return { rule: null, error: `Неизвестный префикс «${line.slice(0, colon)}:». Допустимы: ${RULE_PREFIXES.join(', ')}` }
    }
    // No prefix: an address or a network is an `ip:` line, anything else a site and its subdomains.
    kind = /^[\d.]+(?:\/\d+)?$/.test(line) ? 'ip' : 'suffix'
    value = line
  }
  const parsed = parseValue(kind, value)
  return parsed.ok ? { rule: { kind: parsed.kind, value: parsed.value } } : { rule: null, error: parsed.message }
}

export function parseRoutingText(text: string, action: RouteAction): { rules: RoutingRule[]; errors: LineIssue[] } {
  const rules: RoutingRule[] = []
  const errors: LineIssue[] = []
  const seen = new Set<string>()
  text.split(/\r?\n/).forEach((raw, i) => {
    const { rule, error } = parseRoutingLine(raw)
    if (error) errors.push({ line: i + 1, text: raw.trim(), message: error })
    if (!rule) return
    const key = `${rule.kind}\0${rule.value}`
    if (seen.has(key)) return
    seen.add(key)
    rules.push({ action, ...rule })
  })
  return { rules, errors }
}

const LISTS: readonly RouteAction[] = ['proxy', 'direct', 'block']

/** «Простой»: what its kind sends where — the default, and the action the sites get. */
export const SIMPLE_KINDS: Record<SimpleKind, { final: 'direct' | 'proxy'; action: RouteAction }> = {
  only: { final: 'direct', action: 'proxy' },
  except: { final: 'proxy', action: 'direct' },
  block: { final: 'proxy', action: 'block' }
}

/**
 * The sites of «Простой»: a site per line, or several separated by commas or spaces. A link is fine (the site is taken
 * from it), a prefix is not: prefixes belong to «Продвинутый».
 */
export function parseSites(text: string): { sites: string[]; errors: LineIssue[] } {
  const sites: string[] = []
  const errors: LineIssue[] = []
  const seen = new Set<string>()
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    for (const token of line.split(/[\s,;]+/).filter(Boolean)) {
      // «https://user@www.example.com:8443/path?q» → «www.example.com»
      const host = token.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^.*@/, '').replace(/:\d+$/, '')
      const site = host.includes(':') ? null : normalizeDomain(host)
      if (!site) {
        errors.push({
          line: i + 1,
          text: token,
          message: /^[a-z]+:[^/]/i.test(token) && RULE_PREFIXES.some((p) => token.toLowerCase().startsWith(`${p.toLowerCase()}:`))
            ? 'В простом режиме только сайты; префиксы — в продвинутом'
            : 'Не похоже на сайт (нужно хотя бы две части, например example.com)'
        })
        continue
      }
      if (!seen.has(site)) {
        seen.add(site)
        sites.push(site)
      }
    }
  })
  return { sites, errors }
}

export interface ParsedRouting {
  /** Where everything no rule names goes (in «Простой», from its kind). */
  final: 'direct' | 'proxy'
  /** The rules in force, in the order they are matched. */
  rules: RoutingRule[]
  /** «Простой»: what is wrong with the sites. */
  siteErrors: LineIssue[]
  /** `lists`: errors per list. */
  errors: Record<RouteAction, LineIssue[]>
  /** `rules`: errors per rule, in the order of the rules. */
  ruleErrors: LineIssue[][]
}

/** The mode in force parsed, for the editor to show errors and the helper to get rules. */
export function parseRouting(settings: RoutingSettings): ParsedRouting {
  const out: ParsedRouting = {
    final: settings.final,
    rules: [],
    siteErrors: [],
    errors: { proxy: [], direct: [], block: [] },
    ruleErrors: settings.rules.map(() => [])
  }
  if (settings.mode === 'simple') {
    const { final, action } = SIMPLE_KINDS[settings.simple.kind]
    const { sites, errors } = parseSites(settings.simple.sites)
    out.final = final
    out.siteErrors = errors
    out.rules = sites.map((value) => ({ action, kind: 'suffix' as const, value }))
  } else if (settings.mode === 'rules') {
    settings.rules.forEach((r, i) => {
      const parsed = parseRoutingText(r.lines, r.action)
      out.ruleErrors[i] = parsed.errors
      if (r.enabled) out.rules.push(...parsed.rules)
    })
  } else {
    for (const action of LISTS) {
      const parsed = parseRoutingText(settings[action], action)
      out.errors[action] = parsed.errors
      out.rules.push(...parsed.rules)
    }
  }
  return out
}

/** The `rules` view starts from the three lists, one rule each, so switching over loses nothing. */
export function rulesFromLists(settings: Pick<RoutingSettings, 'proxy' | 'direct' | 'block'>): AdvancedRule[] {
  const names: Record<RouteAction, string> = { proxy: 'Через VPN', direct: 'Напрямую', block: 'Блокировать' }
  return LISTS.filter((a) => settings[a].trim() !== '').map((a) => ({ name: names[a], action: a, lines: settings[a], enabled: true }))
}

/**
 * The first time «Продвинутый» is opened, the sites of «Простой» become `suffix:` lines in the list their kind
 * names (and the default that goes with it), so nothing typed is lost; lists that already have lines are left alone.
 */
export function listsFromSimple(settings: RoutingSettings): Pick<RoutingSettings, 'final' | 'proxy' | 'direct' | 'block'> | null {
  if ([settings.proxy, settings.direct, settings.block].some((t) => t.trim() !== '')) return null
  const { final, action } = SIMPLE_KINDS[settings.simple.kind]
  const { sites } = parseSites(settings.simple.sites)
  if (!sites.length) return null
  return { final, proxy: '', direct: '', block: '', [action]: sites.map((d) => `suffix:${d}`).join('\n') }
}

/** What this platform's helper can do with a rule; the rest is shown as a warning and not sent. */
export interface RoutingCapabilities {
  /** processName / processPath (Linux, with cgroup v2 and nftables). */
  process: boolean
  /** ruleset: geoip-… / geosite-… */
  ruleset: boolean
}

export const NO_CAPABILITIES: RoutingCapabilities = { process: false, ruleset: false }

export function unsupportedRules(rules: RoutingRule[], caps: RoutingCapabilities): { rule: RoutingRule; reason: string }[] {
  const out: { rule: RoutingRule; reason: string }[] = []
  for (const rule of rules) {
    if ((rule.kind === 'processName' || rule.kind === 'processPath') && !caps.process) {
      out.push({ rule, reason: 'правила по программам работают только в Linux' })
    } else if (rule.kind === 'ruleset' && !caps.ruleset) {
      out.push({ rule, reason: 'наборы geoip/geosite пока не поддерживаются' })
    }
  }
  return out
}

/**
 * The routing the helper should apply, or null for «everything through the VPN» (no rules it can use). The
 * lists in settings were validated when they were saved; a line that no longer parses is skipped.
 */
export function resolveRouting(settings: RoutingSettings, caps: RoutingCapabilities = NO_CAPABILITIES): RoutingConfig | null {
  const { final, rules } = parseRouting(settings)
  const skip = new Set(unsupportedRules(rules, caps).map((u) => u.rule))
  const usable = rules.filter((r) => !skip.has(r))
  return usable.length ? { final, rules: usable } : null
}

/** The part of the settings that changes what the helper does; a change of it needs a new connection to show. */
export const routingKey = (r: RoutingSettings): string =>
  JSON.stringify([
    r.mode,
    r.mode === 'simple' ? [r.simple.kind, r.simple.sites] : [r.final, r.mode === 'rules' ? r.rules.map((x) => [x.action, x.lines, x.enabled]) : [r.proxy, r.direct, r.block]]
  ])

/** Text and count for the chip on the main screen. */
export function routingSummary(settings: RoutingSettings, caps: RoutingCapabilities = NO_CAPABILITIES): { text: string; on: boolean } {
  const config = resolveRouting(settings, caps)
  if (!config) return { text: 'Всё через VPN', on: false }
  if (settings.mode === 'simple') {
    const n = config.rules.length
    const what = settings.simple.kind === 'only' ? 'Только' : settings.simple.kind === 'block' ? 'Блок' : 'Кроме'
    return { text: `${what} ${pluralSites(n)}`, on: true }
  }
  return { text: `${settings.name} · ${pluralRules(config.rules.length)}`, on: true }
}

function pluralSites(n: number): string {
  const mod100 = n % 100
  const mod10 = n % 10
  const word = mod100 >= 11 && mod100 <= 14 ? 'сайтов' : mod10 === 1 ? 'сайт' : mod10 >= 2 && mod10 <= 4 ? 'сайта' : 'сайтов'
  return `${n} ${word}`
}

function pluralRules(n: number): string {
  const mod100 = n % 100
  const mod10 = n % 10
  const word = mod100 >= 11 && mod100 <= 14 ? 'правил' : mod10 === 1 ? 'правило' : mod10 >= 2 && mod10 <= 4 ? 'правила' : 'правил'
  return `${n} ${word}`
}

// eslint-disable-next-line no-control-regex
const cleanName = (value: unknown, fallback: string): string => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_ROUTING_NAME) : '') || fallback

/**
 * Keeps a routing object the renderer or an old file sent only if everything in it parses (both modes, not only
 * the one in force: switching must never land on text that was never checked); otherwise null.
 */
export function sanitizeRouting(input: unknown): RoutingSettings | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = input as Record<string, unknown>
  if (raw.final !== 'direct' && raw.final !== 'proxy') return null
  const mode: RoutingMode = raw.mode === 'lists' || raw.mode === 'rules' ? raw.mode : 'simple'
  let simple = ROUTING_DEFAULTS.simple
  if (raw.simple !== undefined) {
    const sm = raw.simple as Record<string, unknown> | null
    if (typeof sm !== 'object' || sm === null || (sm.kind !== 'only' && sm.kind !== 'except' && sm.kind !== 'block')) return null
    if (typeof sm.sites !== 'string' || sm.sites.length > MAX_ROUTING_TEXT) return null
    const parsed = parseSites(sm.sites)
    if (parsed.errors.length || parsed.sites.length > MAX_ROUTING_RULES) return null
    simple = { kind: sm.kind, sites: sm.sites }
  }
  const lists: Partial<Record<RouteAction, string>> = {}
  let simpleTotal = 0
  for (const action of LISTS) {
    const text = raw[action]
    if (typeof text !== 'string' || text.length > MAX_ROUTING_TEXT) return null
    const parsed = parseRoutingText(text, action)
    if (parsed.errors.length) return null
    simpleTotal += parsed.rules.length
    lists[action] = text
  }
  if (simpleTotal > MAX_ROUTING_RULES) return null

  const rules: AdvancedRule[] = []
  let advancedTotal = 0
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules) || raw.rules.length > MAX_ADVANCED_RULES) return null
    for (const item of raw.rules) {
      if (typeof item !== 'object' || item === null) return null
      const r = item as Record<string, unknown>
      if (r.action !== 'proxy' && r.action !== 'direct' && r.action !== 'block') return null
      if (typeof r.lines !== 'string' || r.lines.length > MAX_ROUTING_TEXT) return null
      const parsed = parseRoutingText(r.lines, r.action)
      if (parsed.errors.length) return null
      if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return null
      advancedTotal += parsed.rules.length
      rules.push({ name: cleanName(r.name, `Правило ${rules.length + 1}`), action: r.action, lines: r.lines, enabled: r.enabled !== false })
    }
  }
  if (advancedTotal > MAX_ROUTING_RULES) return null
  return { name: cleanName(raw.name, ROUTING_DEFAULTS.name), mode, simple, final: raw.final, direct: lists.direct ?? '', proxy: lists.proxy ?? '', block: lists.block ?? '', rules }
}

/**
 * Settings written by 0.8.1–0.8.3 («Что идёт через VPN»: a mode and a list of sites) as the simple mode, which is
 * the same thing: «only the list» is `only`, «everything but the list» is `except`.
 */
export function migrateLegacySplit(raw: Record<string, unknown>): RoutingSettings | null {
  const mode = raw.splitMode
  if (mode !== 'include' && mode !== 'exclude') return null
  const list = mode === 'include' ? raw.splitInclude : raw.splitExclude
  if (!Array.isArray(list)) return null
  const sites = list.map((d) => (typeof d === 'string' ? normalizeDomain(d) : null)).filter((d): d is string => d !== null)
  if (!sites.length) return null
  return { ...ROUTING_DEFAULTS, simple: { kind: mode === 'include' ? 'only' : 'except', sites: sites.join('\n') } }
}
