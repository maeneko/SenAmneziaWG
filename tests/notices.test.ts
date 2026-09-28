import { describe, expect, it } from 'vitest'
import type { AppNotice } from '../src/shared/types'
import { orderNotices } from '../src/renderer/src/lib/notices'

const notice = (id: string, priority: AppNotice['priority'], at: number): AppNotice => ({ id, priority, at, tone: 'info', title: id, dismissible: true })
const ids = (list: AppNotice[]): string[] => list.map((n) => n.id)

describe('order of the notifications', () => {
  it('puts the subscription first however old it is, then the newest of each priority', () => {
    const list = [notice('ending', 'high', 1), notice('paid', 'low', 50), notice('works', 'normal', 30), notice('unbound', 'normal', 40), notice('overdue', 'high', 2)]
    expect(ids(orderNotices(list))).toEqual(['overdue', 'ending', 'unbound', 'works', 'paid'])
  })

  it('takes the later of two sent in the same millisecond as the newer, and leaves the list it was given alone', () => {
    const list = [notice('first', 'normal', 5), notice('second', 'normal', 5)]
    expect(ids(orderNotices(list))).toEqual(['second', 'first'])
    expect(ids(list)).toEqual(['first', 'second'])
  })
})
