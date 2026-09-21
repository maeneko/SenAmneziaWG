import { describe, expect, it } from 'vitest'
import type { SetupFailure, SetupProgress } from '../src/shared/types'
import { ERROR_CANCELLED, type ElevatedResult } from '../src/main/setup/elevate'
import type { SetupEvent } from '../src/main/setup/progress'
import { followRemoval, type FollowDeps } from '../src/main/uninstall/follow'

const active = (step: number): SetupEvent => ({ kind: 'step', step, state: 'active' })
const done = (step: number): SetupEvent => ({ kind: 'step', step, state: 'done' })
const failed = (step: number, message: string): SetupEvent => ({ kind: 'failed', step, message })
const ALL: SetupEvent[] = [active(0), done(0), active(1), done(1), active(2), done(2)]

/** A removal whose progress file receives `events`, and whose elevated process ends with `result`. */
function removal(result: ElevatedResult, events: SetupEvent[] = [], extra: Partial<FollowDeps> = {}) {
  const queue = [...events]
  const log: string[] = []
  const progress: SetupProgress[] = []
  const failures: SetupFailure[] = []
  const deps: FollowDeps = {
    run: () => Promise.resolve(result),
    // One event per read: the helper writes them over time.
    read: () => (queue.length ? [queue.shift()!] : []),
    beforeLastDone: () => log.push('beforeLastDone'),
    onProgress: (e) => {
      progress.push(e)
      log.push(`${e.step}:${e.state}`)
    },
    onFailed: (e) => {
      failures.push(e)
      log.push(`failed:${e.step}`)
    },
    pollMs: 1,
    ...extra
  }
  return { deps, log, progress, failures }
}

describe('followRemoval', () => {
  it('is cancelled when the administrator prompt is declined, and nothing is said to have failed', async () => {
    const r = removal({ code: ERROR_CANCELLED, stderr: '' })
    expect(await followRemoval(r.deps)).toBe('cancelled')
    expect(r.failures).toEqual([])
  })

  it('follows the copy in %TEMP% after the installed helper has already exited', async () => {
    // The installed helper hands over and exits 0 before a single step has run.
    const r = removal({ code: 0, stderr: '' }, ALL)
    expect(await followRemoval(r.deps)).toBe('done')
    expect(r.progress).toHaveLength(6)
    expect(r.failures).toEqual([])
  })

  it('forgets the keys before the last step is ticked, not after', async () => {
    const r = removal({ code: 0, stderr: '' }, ALL)
    await followRemoval(r.deps)
    expect(r.log.slice(-2)).toEqual(['beforeLastDone', '2:done'])
  })

  it('turns a failure to forget the keys into a failure of the last step', async () => {
    const r = removal({ code: 0, stderr: '' }, ALL, {
      beforeLastDone: () => {
        throw new Error('Файл занят')
      }
    })
    expect(await followRemoval(r.deps)).toBe('failed')
    expect(r.failures).toEqual([{ step: 2, message: 'Файл занят' }])
    expect(r.progress.some((p) => p.step === 2 && p.state === 'done')).toBe(false)
  })

  it('passes on the failure the helper reported, once, and nothing after it', async () => {
    const r = removal({ code: 0, stderr: '' }, [active(0), done(0), active(1), failed(1, 'служба не останавливается'), active(2)])
    expect(await followRemoval(r.deps)).toBe('failed')
    expect(r.failures).toEqual([{ step: 1, message: 'служба не останавливается' }])
    expect(r.progress.map((p) => `${p.step}:${p.state}`)).toEqual(['0:active', '0:done', '1:active'])
  })

  it('says what went wrong when the helper could not even start', async () => {
    const r = removal({ code: 1, stderr: 'Не найден файл awg-helper.exe' })
    expect(await followRemoval(r.deps)).toBe('failed')
    expect(r.failures).toEqual([{ step: 0, message: 'Не найден файл awg-helper.exe' }])
  })

  it('does not report a failure twice when the helper both reported it and exited with an error', async () => {
    let finish: (r: ElevatedResult) => void = () => {}
    const r = removal({ code: 0, stderr: '' }, [active(0), failed(0, 'нет прав')], {
      run: () => new Promise((resolve) => (finish = resolve))
    })
    const outcome = followRemoval(r.deps)
    await new Promise((resolve) => setTimeout(resolve, 30)) // both events read while it runs
    finish({ code: 1, stderr: 'remove: нет прав' })
    expect(await outcome).toBe('failed')
    expect(r.failures).toEqual([{ step: 0, message: 'нет прав' }])
  })

  it('gives up on a helper that has gone quiet half-way', async () => {
    let clock = 0
    const r = removal({ code: 0, stderr: '' }, [active(0), done(0), active(1)], {
      idleMs: 1000,
      now: () => (clock += 100)
    })
    expect(await followRemoval(r.deps)).toBe('failed')
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({ step: 1 })
    expect(r.failures[0].message).toMatch(/остановилось на полпути/)
  })
})
