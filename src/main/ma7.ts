import type { PaymentDetails, Profile, ProfileStatus, PromoDiscount, PromoResult } from '../shared/types'
import { UPDATE_ORIGIN } from './update/server'

/**
 * MA7's site API (~/Documents/ma7amnesia, api/src/routes/page.routes.ts): «Профиль» by the login a master key's
 * link carries. The site API knows a user by that login alone — no token — which is also why the login is
 * kept out of the journal (logger.ts).
 */
export const MA7_ORIGIN = UPDATE_ORIGIN

const TIMEOUT_MS = 15_000

/** Users.status in MA7: 0 not paid, 1 active, 2 payment being checked, 3 payment overdue. */
const STATUS: ProfileStatus[] = ['unpaid', 'active', 'processing', 'overdue']

/** A failure with a message for the person; the window shows it as it is. */
export class Ma7Error extends Error {}

export interface Ma7Deps {
  /** Electron's net.fetch in the app, so the system proxy applies. */
  fetch: typeof fetch
  origin?: string
}

type Body = Record<string, unknown>
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function parseProfile(login: string, data: unknown): Profile {
  const d = (data ?? {}) as Body
  const status = num(d.status)
  const balance = num(d.balance)
  const monthly = num(d.reqBalance)
  if (status === null || !STATUS[status] || balance === null || monthly === null) throw new Ma7Error('MA7 прислал непонятный ответ')
  const end = typeof d.end_time === 'string' ? Date.parse(d.end_time) : NaN
  return {
    login,
    status: STATUS[status],
    paidUntil: Number.isFinite(end) ? end : null,
    balance,
    monthly,
    keys: num(d.activeKeys) ?? 0
  }
}

/** applypromo answers with the code itself: discount_type 0 ₽ / 1 %, applies_to 1 whole subscription / 2 each key. */
export function parseDiscount(d: Body): PromoDiscount {
  return {
    kind: num(d.discount_type) === 1 ? 'percent' : 'rubles',
    value: num(d.discount_value) ?? 0,
    perDevice: num(d.applies_to) === 2
  }
}

export interface Ma7Client {
  profile(login: string): Promise<Profile>
  promo(login: string, code: string): Promise<PromoResult>
  payment(login: string): Promise<PaymentDetails>
  paid(login: string): Promise<void>
}

export function ma7Client(deps: Ma7Deps): Ma7Client {
  const origin = deps.origin ?? MA7_ORIGIN

  /** `data`: the JSON answer, or null when there was none (a route MA7 does not have answers with HTML). */
  async function post(path: string, body: Body): Promise<{ status: number; data: Body | null }> {
    let res: Response
    try {
      res = await deps.fetch(`${origin}/api/page/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch {
      throw new Ma7Error('Нет связи с MA7')
    }
    let data: Body | null = null
    try {
      const json: unknown = await res.json()
      if (json && typeof json === 'object') data = json as Body
    } catch {
      /* not JSON */
    }
    return { status: res.status, data }
  }

  const said = (data: Body | null): string | null => text(data?.message)
  /** MA7 answers a route it does not have with 404 «Маршрут не найден» (api/src/app.ts); a proxy, with HTML. */
  const noRoute = (status: number, data: Body | null): boolean => status === 404 && (!data || said(data) === 'Маршрут не найден')
  /** Payment through the application needs routes MA7 does not have yet: until then, a plain word about it. */
  const NO_PAYMENT = 'Оплата из приложения пока недоступна. Оплатите подписку в Telegram-боте MA7'

  return {
    async profile(login) {
      const { status, data } = await post('getinfologin', { login })
      if (status === 404) throw new Ma7Error('MA7 не нашёл этот аккаунт')
      if (status !== 200 || data?.success !== true) throw new Ma7Error(said(data) ?? `MA7 ответил ${status}`)
      return parseProfile(login, data.data)
    },

    async promo(login, code) {
      const { status, data } = await post('applypromo', { login, code })
      if (status === 200 && data?.success === true) return { ok: true, discount: parseDiscount(data) }
      // A code that does not apply is an answer, not a failure: MA7 says why in so many words.
      if (status >= 400 && status < 500 && said(data)) return { ok: false, error: said(data) as string }
      throw new Ma7Error(said(data) ?? `MA7 ответил ${status}`)
    },

    async payment(login) {
      const { status, data } = await post('payment', { login })
      if (noRoute(status, data)) throw new Ma7Error(NO_PAYMENT)
      if (status !== 200 || data?.success !== true) throw new Ma7Error(said(data) ?? `MA7 ответил ${status}`)
      const bank = text(data.bank)
      const phone = text(data.phone)
      if (!bank || !phone) throw new Ma7Error('MA7 прислал реквизиты не полностью')
      const recipient = text(data.recipient)
      return { bank, phone, ...(recipient ? { recipient } : {}) }
    },

    async paid(login) {
      const { status, data } = await post('paid', { login })
      if (noRoute(status, data)) throw new Ma7Error(NO_PAYMENT)
      if (status !== 200 || data?.success !== true) throw new Ma7Error(said(data) ?? `MA7 ответил ${status}`)
    }
  }
}
