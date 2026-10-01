import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ma7Notice } from '../src/main/ma7'
import { FOCUS_MS, Ma7Notices, forgotten, toAppNotices } from '../src/main/ma7Notices'

const n = (id: string, over: Partial<Ma7Notice> = {}): Ma7Notice => ({
  id,
  kind: 'announce',
  tone: 'info',
  priority: 'normal',
  title: `Заголовок ${id}`,
  at: 1000,
  ...over
})

describe('toAppNotices', () => {
  it('keeps accounts apart by the login in the id, and every notice can be closed', () => {
    const out = toAppNotices(
      new Map([
        ['ma7_a', [n('n1')]],
        ['ma7_b', [n('n1')]]
      ])
    )
    expect(out.map((x) => x.id)).toEqual(['ma7-ma7_a-n1', 'ma7-ma7_b-n1'])
    expect(out.every((x) => x.dismissible)).toBe(true)
  })

  it('leads to «Профиль» only for what is about the subscription', () => {
    const out = toAppNotices(
      new Map([['l', [n('a'), n('ending-2026-10-03', { kind: 'ending' }), n('o', { kind: 'overdue' }), n('p', { kind: 'payment_ok' })]]])
    )
    expect(out.map((x) => x.action?.view)).toEqual([undefined, 'profile', 'profile', 'profile'])
  })

  it('passes the text only when there is one', () => {
    const [a, b] = toAppNotices(new Map([['l', [n('a'), n('b', { text: 'Ночью' })]]]))
    expect('text' in a).toBe(false)
    expect(b.text).toBe('Ночью')
  })
})

describe('forgotten', () => {
  it('lists closed notices of this account that MA7 no longer sends', () => {
    const dismissed = ['ma7-l-n1', 'ma7-l-n2', 'ma7-other-n1', 'notices-beta', 'sen-revoked-x']
    expect(forgotten(dismissed, 'l', [n('n2')])).toEqual(['ma7-l-n1'])
  })
})

describe('Ma7Notices', () => {
  let accounts: string[]
  let dismissed: string[]
  let now: number
  const host = {
    fetch: vi.fn<(login: string) => Promise<Ma7Notice[]>>(),
    forget: vi.fn<(ids: string[]) => void>(),
    changed: vi.fn(),
    log: vi.fn()
  }
  const make = (): Ma7Notices =>
    new Ma7Notices({ ...host, accounts: () => accounts, dismissed: () => dismissed, now: () => now })

  beforeEach(() => {
    accounts = ['l']
    dismissed = []
    now = 1_000_000
    host.fetch.mockReset().mockResolvedValue([n('n1')])
    host.forget.mockReset()
    host.changed.mockReset()
    host.log.mockReset()
  })

  it('shows what MA7 said and tells the window once, not on an identical answer', async () => {
    const m = make()
    await m.refresh()
    expect(m.list().map((x) => x.id)).toEqual(['ma7-l-n1'])
    expect(host.changed).toHaveBeenCalledTimes(1)
    await m.refresh()
    expect(host.changed).toHaveBeenCalledTimes(1)
  })

  it('keeps the old list when MA7 does not answer, and says so in the log', async () => {
    const m = make()
    await m.refresh()
    host.fetch.mockRejectedValue(new Error('Нет связи с MA7'))
    await m.refresh()
    expect(m.list()).toHaveLength(1)
    expect(host.log).toHaveBeenCalledWith('warn', expect.stringContaining('Нет связи'))
  })

  it('forgets closed notices MA7 dropped, but never on a failed answer', async () => {
    dismissed = ['ma7-l-n1', 'ma7-l-gone']
    const m = make()
    host.fetch.mockRejectedValueOnce(new Error('x'))
    await m.refresh()
    expect(host.forget).not.toHaveBeenCalled()
    await m.refresh()
    expect(host.forget).toHaveBeenCalledWith(['ma7-l-gone'])
  })

  it('takes a logged-out account\'s notices away at once', async () => {
    const m = make()
    await m.refresh()
    accounts = []
    expect(m.list()).toEqual([])
    await m.refresh()
    expect(host.changed).toHaveBeenCalledTimes(2)
  })

  it('looks again for a new account at once, and for the rest not before the pause is over', async () => {
    const m = make()
    await m.refresh()
    host.fetch.mockClear()
    m.poke()
    expect(host.fetch).not.toHaveBeenCalled()
    now += FOCUS_MS
    m.poke()
    expect(host.fetch).toHaveBeenCalledTimes(1)
    await m.refresh()
    host.fetch.mockClear()
    accounts = ['l', 'm']
    m.poke()
    await m.refresh()
    expect(host.fetch).toHaveBeenCalledWith('m')
  })

  it('does not ask an account again and again when it never answers', async () => {
    host.fetch.mockRejectedValue(new Error('x'))
    const m = make()
    await m.refresh()
    host.fetch.mockClear()
    m.poke()
    expect(host.fetch).not.toHaveBeenCalled()
  })
})
