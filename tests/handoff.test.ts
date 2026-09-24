import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readMarker, waitForMarker, writeMarker } from '../src/main/update/handoff'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-handoff-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('handoff markers', () => {
  it('says nothing until the installer does', () => {
    expect(readMarker(dir)).toBeNull()
  })

  it('reads each thing the installer can say', () => {
    writeMarker(dir, 'cancelled')
    expect(readMarker(dir)).toEqual({ kind: 'cancelled' })
    rmSync(join(dir, 'cancelled'))
    writeMarker(dir, 'failed', 'нет места на диске\n')
    expect(readMarker(dir)).toEqual({ kind: 'failed', message: 'нет места на диске' })
    writeMarker(dir, 'shown')
    expect(readMarker(dir)).toEqual({ kind: 'shown' })
  })

  it('a failure without its text is still a failure, with a message', () => {
    writeMarker(dir, 'failed')
    expect(readMarker(dir)).toMatchObject({ kind: 'failed', message: expect.stringMatching(/подготовить/) })
  })
})

describe('waitForMarker', () => {
  it('returns as soon as the installer has spoken', async () => {
    setTimeout(() => writeMarker(dir, 'shown'), 30)
    expect(await waitForMarker(dir, { stepMs: 5 })).toEqual({ kind: 'shown' })
  })

  it('gives up after the timeout', async () => {
    expect(await waitForMarker(dir, { timeoutMs: 40, stepMs: 5 })).toEqual({ kind: 'timeout' })
  })

  it('does not wait out the timeout for an installer that died without a word', async () => {
    const started = Date.now()
    const said = await waitForMarker(dir, { timeoutMs: 5000, stepMs: 5, alive: () => false })
    expect(said).toMatchObject({ kind: 'failed' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('takes a marker written just before the installer exited', async () => {
    let calls = 0
    const said = await waitForMarker(dir, {
      stepMs: 1,
      alive: () => {
        if (calls++ === 0) writeMarker(dir, 'cancelled')
        return false
      }
    })
    expect(said).toEqual({ kind: 'cancelled' })
  })
})
