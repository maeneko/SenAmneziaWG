import { describe, expect, it } from 'vitest'
import type { AppNotice, UpdateState } from '../src/shared/types'
import { importantNotices, updateNotice } from '../src/main/systemNotices'

const notice = (id: string, priority: AppNotice['priority'], over: Partial<AppNotice> = {}): AppNotice => ({
  id,
  priority,
  at: 1,
  tone: 'warn',
  title: `Заголовок ${id}`,
  dismissible: true,
  ...over
})

describe('importantNotices', () => {
  it('takes the subscription ones and skips what the system already said', () => {
    const list = [notice('overdue', 'high'), notice('announce', 'normal'), notice('paid', 'low')]
    expect(importantNotices(list, []).map((n) => n.id)).toEqual(['overdue'])
    expect(importantNotices(list, ['overdue'])).toEqual([])
    expect(importantNotices([], [])).toEqual([])
  })

  it('keeps the text and the section a click leads to, with a fallback body and the main screen', () => {
    const list = [
      notice('a', 'high', { text: 'Продлите подписку', action: { label: 'Профиль', view: 'profile' } }),
      notice('b', 'high')
    ]
    expect(importantNotices(list, [])).toEqual([
      { id: 'a', title: 'Заголовок a', body: 'Продлите подписку', view: 'profile' },
      { id: 'b', title: 'Заголовок b', body: 'Откройте SenAWG, чтобы узнать подробности.', view: 'tunnels' }
    ])
  })
})

describe('updateNotice', () => {
  const available: UpdateState = { kind: 'available', version: '0.6.0', notes: [], total: 10 }
  const ready: UpdateState = { kind: 'ready', version: '0.6.0', notes: [] }

  it('says a new version once, and a later one again', () => {
    expect(updateNotice(available, null)?.version).toBe('0.6.0')
    expect(updateNotice(available, '0.6.0')).toBeNull()
    expect(updateNotice({ ...available, version: '0.7.0' }, '0.6.0')?.version).toBe('0.7.0')
  })

  it('with automatic updates it speaks at `ready`, once', () => {
    const fresh = updateNotice(ready, null)
    expect(fresh?.notice.view).toBe('settings')
    expect(fresh?.notice.title).toContain('0.6.0')
    expect(fresh?.notice.body).toContain('установить')
    expect(updateNotice(ready, '0.6.0')).toBeNull()
  })

  it('says nothing while checking, downloading or failing', () => {
    for (const state of [
      { kind: 'idle', checkedAt: null },
      { kind: 'checking' },
      { kind: 'downloading', version: '0.6.0', notes: [], received: 1, total: 10 },
      { kind: 'failed', reason: 'network', message: 'нет' }
    ] as UpdateState[]) {
      expect(updateNotice(state, null)).toBeNull()
    }
  })
})
