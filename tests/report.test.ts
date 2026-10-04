import { describe, expect, it } from 'vitest'
import { buildReport, reportHost } from '../src/main/report'
import { REPORT_LOGS_MAX, type LogEntry } from '../src/shared/types'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const entry = (id: number, minutesAgo: number, message: string): LogEntry => ({
  id,
  ts: NOW - minutesAgo * 60_000,
  level: 'info',
  source: 'app',
  message
})

const SOURCE = {
  message: 'Не подключается',
  tunnel: { name: 'Нидерланды', endpoint: '185.12.34.56:51820' },
  entries: [entry(1, 45, 'давно'), entry(2, 20, 'рукопожатие не прошло'), entry(3, 1, 'переподключение')],
  now: NOW,
  appVersion: 'beta-0.7.6-mac',
  systemInfo: 'Система: darwin 25.6.0, arm64',
  withLogs: true,
  withDevice: true
}

describe('buildReport', () => {
  it('the server by name and address without the port, the last half hour of the journal, the device', () => {
    const { report, logEntries } = buildReport(SOURCE)
    expect(report.server).toBe('Нидерланды (185.12.34.56)')
    expect(logEntries).toBe(2)
    expect(report.logs).toContain('рукопожатие не прошло')
    expect(report.logs).toContain('переподключение')
    expect(report.logs).not.toContain('давно')
    expect(report.systemInfo).toBe('Система: darwin 25.6.0, arm64')
    expect(report.appVersion).toBe('beta-0.7.6-mac')
    expect(report.message).toBe('Не подключается')
  })

  it('leaves out what the person switched off; the version always goes', () => {
    const { report, logEntries } = buildReport({ ...SOURCE, tunnel: undefined, withLogs: false, withDevice: false })
    expect(report).toEqual({ message: 'Не подключается', server: null, logs: null, appVersion: 'beta-0.7.6-mac', systemInfo: null })
    expect(logEntries).toBe(0)
  })

  it('a quiet half hour sends no journal at all', () => {
    const { report, logEntries } = buildReport({ ...SOURCE, entries: [entry(1, 45, 'давно')] })
    expect(report.logs).toBeNull()
    expect(logEntries).toBe(0)
  })

  it('a journal longer than MA7 keeps goes as its tail', () => {
    const long = Array.from({ length: 4000 }, (_, i) => entry(i, 5, `строка ${i} ${'x'.repeat(100)}`))
    const { report } = buildReport({ ...SOURCE, entries: long })
    expect(report.logs).toHaveLength(REPORT_LOGS_MAX)
    expect(report.logs).toContain('строка 3999')
  })
})

describe('reportHost', () => {
  it('drops the port, IPv6 too, and keeps what it cannot read', () => {
    expect(reportHost('185.12.34.56:51820')).toBe('185.12.34.56')
    expect(reportHost('[2001:db8::1]:51820')).toBe('2001:db8::1')
    expect(reportHost('vpn.example')).toBe('vpn.example')
  })
})
