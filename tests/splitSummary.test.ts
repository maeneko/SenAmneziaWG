import { describe, expect, it } from 'vitest'
import { splitKey, splitSummary } from '../src/renderer/src/lib/split'

const s = (splitMode: 'off' | 'include' | 'exclude', splitInclude: string[] = [], splitExclude: string[] = []) => ({ splitMode, splitInclude, splitExclude })
const sites = (n: number): string[] => Array.from({ length: n }, (_, i) => `h${i}.example.com`)

describe('splitSummary', () => {
  it('off, and a mode with an empty list, both say everything goes through the VPN — and are not «on»', () => {
    expect(splitSummary(s('off', sites(3), sites(3)))).toEqual({ text: 'Всё через VPN', on: false })
    expect(splitSummary(s('exclude'))).toEqual({ text: 'Список пуст — всё через VPN', on: false })
    expect(splitSummary(s('include'))).toEqual({ text: 'Список пуст — всё через VPN', on: false })
  })

  it('names the mode and the count of the list that mode uses, with the Russian plural', () => {
    expect(splitSummary(s('exclude', sites(9), sites(1)))).toEqual({ text: 'Кроме 1 сайт', on: true })
    expect(splitSummary(s('exclude', [], sites(2))).text).toBe('Кроме 2 сайта')
    expect(splitSummary(s('include', sites(5), sites(1))).text).toBe('Только 5 сайтов')
    expect(splitSummary(s('include', sites(11))).text).toBe('Только 11 сайтов')
    expect(splitSummary(s('include', sites(21))).text).toBe('Только 21 сайт')
  })
})

describe('splitKey', () => {
  it('changes with the mode or either list, and only then', () => {
    const base = splitKey(s('exclude', ['a.com'], ['b.com']))
    expect(splitKey(s('exclude', ['a.com'], ['b.com']))).toBe(base)
    expect(splitKey(s('include', ['a.com'], ['b.com']))).not.toBe(base)
    expect(splitKey(s('exclude', ['a.com'], ['b.com', 'c.com']))).not.toBe(base)
    expect(splitKey(s('exclude', ['x.com'], ['b.com']))).not.toBe(base)
  })
})
