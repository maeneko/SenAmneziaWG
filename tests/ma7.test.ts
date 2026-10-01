import { describe, expect, it, vi } from 'vitest'
import { Ma7Error, ma7Client, parseProfile } from '../src/main/ma7'

// The answers are the ones MA7's page routes give (ma7amnesia api/src/controllers/page.controller.ts).
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const html = (status: number): Response => new Response('<pre>Cannot POST /api/page/payment</pre>', { status })

function client(answer: (path: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://ma7.test/api/page/', '')
    return answer(path, JSON.parse(String(init?.body)))
  })
  return { ma7: ma7Client({ fetch: fetch as unknown as typeof globalThis.fetch, origin: 'https://ma7.test' }), fetch }
}

const INFO = { id: 12, status: 1, balance: 350.5, reqBalance: 300, activeKeys: 2, end_time: '2026-10-16T09:00:00.000Z' }

describe('MA7 profile', () => {
  it('asks getinfologin by the login and reads what the site reads', async () => {
    const { ma7, fetch } = client(() => json(200, { success: true, data: INFO }))
    expect(await ma7.profile('ma7_3f9a1c')).toEqual({
      login: 'ma7_3f9a1c',
      status: 'active',
      paidUntil: Date.parse('2026-10-16T09:00:00.000Z'),
      balance: 350.5,
      monthly: 300,
      keys: 2
    })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://ma7.test/api/page/getinfologin')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ login: 'ma7_3f9a1c' }) })
  })

  it('knows each status, and an account never paid has no date', () => {
    const statuses = [0, 1, 2, 3].map((status) => parseProfile('x', { ...INFO, status }).status)
    expect(statuses).toEqual(['unpaid', 'active', 'processing', 'overdue'])
    expect(parseProfile('x', { ...INFO, end_time: null }).paidUntil).toBeNull()
    // DECIMAL columns come as strings when the pool is not told otherwise.
    expect(parseProfile('x', { ...INFO, balance: '120.00' }).balance).toBe(120)
  })

  it('refuses an answer it cannot read rather than show made-up numbers', () => {
    expect(() => parseProfile('x', { ...INFO, status: 7 })).toThrow(Ma7Error)
    expect(() => parseProfile('x', { ...INFO, balance: undefined })).toThrow(Ma7Error)
    expect(() => parseProfile('x', null)).toThrow(Ma7Error)
  })

  it('says plainly when the login is unknown, the server fails, or there is no network', async () => {
    await expect(client(() => json(404, { success: false, message: 'Пользователь не найден' })).ma7.profile('x')).rejects.toThrow('MA7 не нашёл этот аккаунт')
    await expect(client(() => json(500, { success: false, message: 'Внутренняя ошибка сервера' })).ma7.profile('x')).rejects.toThrow('Внутренняя ошибка сервера')
    await expect(client(() => Promise.reject(new TypeError('fetch failed'))).ma7.profile('x')).rejects.toThrow('Нет связи с MA7')
  })
})

describe('MA7 promo code', () => {
  it('turns the code MA7 applied into what it takes off', async () => {
    const { ma7, fetch } = client(() => json(200, { success: true, discount_type: 1, discount_value: 10, applies_to: 2 }))
    expect(await ma7.promo('ma7_3f9a1c', 'AUTUMN')).toEqual({ ok: true, discount: { kind: 'percent', value: 10, perDevice: true } })
    expect(fetch.mock.calls[0][1]?.body).toBe(JSON.stringify({ login: 'ma7_3f9a1c', code: 'AUTUMN' }))
    const rubles = await client(() => json(200, { success: true, discount_type: 0, discount_value: 50, applies_to: 1 })).ma7.promo('x', 'A')
    expect(rubles).toEqual({ ok: true, discount: { kind: 'rubles', value: 50, perDevice: false } })
  })

  it('passes on why a code does not apply, and fails only when MA7 does', async () => {
    expect(await client(() => json(400, { success: false, message: 'Промокод истёк.' })).ma7.promo('x', 'A')).toEqual({ ok: false, error: 'Промокод истёк.' })
    await expect(client(() => json(500, { success: false })).ma7.promo('x', 'A')).rejects.toThrow('MA7 ответил 500')
  })
})

describe('MA7 payment', () => {
  it('says payment is not there yet while MA7 has no such route', async () => {
    await expect(client(() => html(404)).ma7.payment('x')).rejects.toThrow(/пока недоступна/)
    await expect(client(() => html(404)).ma7.paid('x')).rejects.toThrow(/пока недоступна/)
    // What MA7 itself answers for a route it does not have.
    const missing = client(() => json(404, { success: false, message: 'Маршрут не найден' })).ma7
    await expect(missing.payment('x')).rejects.toThrow(/пока недоступна/)
    await expect(missing.paid('x')).rejects.toThrow(/пока недоступна/)
  })

  it('reads the requisites once MA7 gives them, and needs both the bank and the number', async () => {
    const { ma7 } = client(() => json(200, { success: true, bank: 'Т-Банк', phone: '+7 900 000-00-00' }))
    expect(await ma7.payment('x')).toEqual({ bank: 'Т-Банк', phone: '+7 900 000-00-00' })
    await expect(client(() => json(200, { success: true, bank: 'Т-Банк' })).ma7.payment('x')).rejects.toThrow(/не полностью/)
  })

  it('«Подтвердить» succeeds only on MA7\'s word', async () => {
    await expect(client(() => json(200, { success: true })).ma7.paid('x')).resolves.toBeUndefined()
    await expect(client(() => json(404, { success: false, message: 'Пользователь не найден.' })).ma7.paid('x')).rejects.toThrow('Пользователь не найден.')
  })
})

describe('MA7 notice center', () => {
  const N = { id: 'n12', kind: 'announce', tone: 'warn', priority: 'high', title: 'Работы', text: 'Ночью', at: 1_790_000_000_000 }

  it('asks getnotices by the login and reads the list', async () => {
    const { ma7, fetch } = client(() => json(200, { success: true, notices: [N] }))
    expect(await ma7.notices('ma7_3f9a1c')).toEqual([N])
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://ma7.test/api/page/getnotices')
    expect(init).toMatchObject({ body: JSON.stringify({ login: 'ma7_3f9a1c' }) })
  })

  it('drops what does not fit and cuts what is too long', async () => {
    const { ma7 } = client(() =>
      json(200, {
        success: true,
        notices: [
          N,
          { ...N, id: '' },
          { ...N, title: '  ' },
          { ...N, at: 'yesterday' },
          { ...N, id: 'n13', tone: 'rainbow', priority: 'urgent', text: 'я'.repeat(2000), title: 'т'.repeat(300) },
          null
        ]
      })
    )
    const out = await ma7.notices('x')
    expect(out.map((n) => n.id)).toEqual(['n12', 'n13'])
    expect(out[1]).toMatchObject({ tone: 'info', priority: 'normal' })
    expect(out[1].text).toHaveLength(1000)
    expect(out[1].title).toHaveLength(120)
  })

  it('has nothing to say while MA7 has no such route or no such account', async () => {
    expect(await client(() => html(404)).ma7.notices('x')).toEqual([])
    expect(await client(() => json(404, { success: false, message: 'Маршрут не найден' })).ma7.notices('x')).toEqual([])
    expect(await client(() => json(404, { success: false, message: 'Пользователь не найден' })).ma7.notices('x')).toEqual([])
  })

  it('fails on a server error, so the old list is kept', async () => {
    await expect(client(() => json(500, { success: false, message: 'Внутренняя ошибка сервера' })).ma7.notices('x')).rejects.toThrow(Ma7Error)
  })
})
