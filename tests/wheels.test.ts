import { describe, expect, it } from 'vitest'
import { wheelPairs } from '../src/renderer/src/lib/wheels'

/** Only the wheels that turn, as «before→after». */
const turning = (was: string, now: string): string[] =>
  wheelPairs(was, now)
    .filter(([, before, after]) => before !== after)
    .map(([key, before, after]) => `${key}:${before}→${after}`)

describe('wheelPairs', () => {
  it('turns only the digits that changed, units under units', () => {
    expect(turning('150', '160')).toEqual(['w1:5→6'])
    // 9 stays: the tens are 9 in both
    expect(turning('95', '190')).toEqual(['w2:→1', 'w0:5→0'])
    expect(turning('3', '4')).toEqual(['w0:3→4'])
  })

  it('a digit and a group space the number gains come out of nothing', () => {
    expect(turning('950', '1 140')).toEqual(['w4:→1', 'w3:→ ', 'w2:9→1', 'w1:5→4'])
  })

  it('kopecks are matched from the comma, never against the whole part', () => {
    expect(turning('5 066,67', '3 800')).toEqual(['w4:5→3', 'w2:0→8', 'w1:6→0', 'w0:6→0', 'comma:,→', 'f0:6→', 'f1:7→'])
    expect(turning('12,5', '12,75')).toEqual(['f0:5→7', 'f1:→5'])
  })

  it('the same number turns nothing, and keys name the places', () => {
    expect(turning('1 140', '1 140')).toEqual([])
    expect(wheelPairs('9,5', '10').map(([key]) => key)).toEqual(['w1', 'w0', 'comma', 'f0'])
  })
})
