import { describe, expect, it } from 'vitest'
import { pkexecAccepted, pkexecFailure } from '../src/main/tunnel/linux/serviceStart'

describe('pkexec exit codes (helper/setup_linux.go, polkit action ru.senawg.helper.service)', () => {
  it('accepts only a clean 0 — unlike sc.exe, pkexec has no "already running" code of its own', () => {
    expect(pkexecAccepted(0)).toBe(true)
    expect(pkexecAccepted(1)).toBe(false)
  })

  it.each([
    [126, 'CANCELLED', /отменено/],
    [127, 'NO_ACCESS', /Недостаточно прав/],
    [-1, 'NOT_RUNNING', /pkexec/]
  ])('gives up at once on code %i: %s', (code, errCode, message) => {
    const err = pkexecFailure(code)
    expect(err).toMatchObject({ code: errCode })
    expect(err?.message).toMatch(message)
  })

  it('is worth retrying for anything else', () => {
    expect(pkexecFailure(1)).toBeNull()
  })
})
