import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Profile } from '../src/shared/types'

// The payment request is kept in localStorage, so the red card outlives a restart.
const store: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v
  }
})
const { dismissRejection, paymentOutcome, paymentRejected, startPayment, trackPayment } = await import('../src/renderer/src/lib/payments')

const END = 1_800_000_000_000
const account = (over: Partial<Profile> = {}): Profile => ({
  login: 'ma7_3f9a1c.7K3MQX9P2HWDR4TN',
  status: 'active',
  paidUntil: END,
  balance: 50,
  monthly: 300,
  keys: 2,
  ...over
})

beforeEach(() => dismissRejection(account().login))

describe('paymentOutcome', () => {
  const before = { balance: 50, paidUntil: END }

  it('no answer while the transfer is checked', () => {
    expect(paymentOutcome(before, account({ status: 'processing' }))).toBeNull()
  })

  it('a renewal: the money on the balance, the date as it was — taken', () => {
    expect(paymentOutcome(before, account({ balance: 350 }))).toBe('approved')
  })

  it('a first payment: the period set, the balance as it was (paid and charged at once) — taken', () => {
    expect(paymentOutcome({ balance: 0, paidUntil: null }, account({ balance: 0, paidUntil: END }))).toBe('approved')
  })

  it('the account back where it was — turned down', () => {
    expect(paymentOutcome(before, account({ status: 'overdue' }))).toBe('rejected')
    expect(paymentOutcome(before, account())).toBe('rejected')
  })
})

describe('trackPayment', () => {
  it('«Подтвердить», then the admin turns it down: remembered until dismissed, and kept on disk', () => {
    startPayment(account())
    expect(trackPayment(account({ status: 'processing' }))).toBeNull()
    expect(trackPayment(account())).toBe('rejected')
    expect(paymentRejected(account().login)).toBe(true)
    expect(store['awg:payments']).toContain('rejected')
    dismissRejection(account().login)
    expect(paymentRejected(account().login)).toBe(false)
  })

  it('a request sent from the bot: the first `processing` seen is the baseline', () => {
    expect(trackPayment(account({ status: 'processing', balance: 50 }))).toBeNull()
    expect(trackPayment(account({ balance: 350 }))).toBe('approved')
    expect(paymentRejected(account().login)).toBe(false)
  })

  it('a new request clears an old rejection', () => {
    startPayment(account())
    trackPayment(account())
    expect(paymentRejected(account().login)).toBe(true)
    trackPayment(account({ status: 'processing' }))
    expect(paymentRejected(account().login)).toBe(false)
  })

  it('nothing pending — nothing to say', () => {
    expect(trackPayment(account({ login: 'ma7_000000' }))).toBeNull()
    expect(paymentRejected('ma7_000000')).toBe(false)
  })
})
