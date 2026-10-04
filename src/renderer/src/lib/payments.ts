import type { Profile } from '@shared/types'

const KEY = 'awg:payments'

/** What the account looked like while the admin checked the transfer: the answer is read against it. */
interface Baseline {
  balance: number
  paidUntil: number | null
}

/**
 * The payment request this computer knows about, per login: waiting for the admin (`pending`, with the account as
 * it was), or turned down (`rejected`: epoch ms, until «Понятно» or a new payment). Kept across restarts — the
 * admin may answer while the application is closed, and the red card must still be there when it opens.
 */
type Entry = { pending: Baseline } | { rejected: number }

export type PaymentOutcome = 'approved' | 'rejected'

const entries = new Map<string, Entry>(read())

function read(): [string, Entry][] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Entry>
    return Object.entries(saved).filter(
      ([, e]) => e && (('pending' in e && Number.isFinite(e.pending?.balance)) || ('rejected' in e && Number.isFinite(e.rejected)))
    )
  } catch {
    return []
  }
}

function write(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* the red card is lost on restart, nothing worse */
  }
}

/**
 * The admin's answer as MA7 shows it in the account. Taking a payment puts the money on the balance (a renewal: the
 * scheduler charges it when the period ends) or, the first time, sets the period; turning it down puts the status
 * back and changes neither. Still `processing` — no answer yet.
 */
export function paymentOutcome(before: Baseline, now: Profile): PaymentOutcome | null {
  if (now.status === 'processing') return null
  const grew = now.balance > before.balance || (now.paidUntil ?? 0) > (before.paidUntil ?? 0)
  return grew ? 'approved' : 'rejected'
}

/** «Подтвердить» went through: the account as it was before is what the answer is read against. */
export function startPayment(profile: Profile): void {
  entries.set(profile.login, { pending: { balance: profile.balance, paidUntil: profile.paidUntil } })
  write()
}

/**
 * Every fresh answer about the account goes through here. A request sent from the bot shows up as `processing`
 * the first time, and the account as it is then is the baseline. The answer, once it comes, is returned; a
 * rejection stays remembered.
 */
export function trackPayment(profile: Profile): PaymentOutcome | null {
  const login = profile.login
  const entry = entries.get(login)
  if (profile.status === 'processing') {
    if (!entry || !('pending' in entry)) startPayment(profile)
    return null
  }
  if (!entry || !('pending' in entry)) return null
  const outcome = paymentOutcome(entry.pending, profile)
  if (outcome === 'rejected') entries.set(login, { rejected: Date.now() })
  else entries.delete(login)
  write()
  return outcome
}

export const paymentRejected = (login: string): boolean => {
  const entry = entries.get(login)
  return entry !== undefined && 'rejected' in entry
}

/** «Понятно» or «Оплатить снова»: the red card goes. */
export function dismissRejection(login: string): void {
  if (!paymentRejected(login)) return
  entries.delete(login)
  write()
}
