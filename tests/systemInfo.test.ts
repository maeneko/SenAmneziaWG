import { describe, expect, it } from 'vitest'
import { cpuBusyShare, formatDevice, osName, parseOsRelease, type CpuTimes, type DeviceFacts } from '../src/main/systemInfo'

describe('parseOsRelease', () => {
  it('reads PRETTY_NAME, quoted or not', () => {
    expect(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n')).toBe('Ubuntu 24.04.1 LTS')
    expect(parseOsRelease("PRETTY_NAME='Fedora Linux 40'\n")).toBe('Fedora Linux 40')
    expect(parseOsRelease('PRETTY_NAME=Arch Linux\n')).toBe('Arch Linux')
  })
  it('gives null without it', () => expect(parseOsRelease('NAME=Foo\n')).toBeNull())
})

describe('osName', () => {
  it('names the system as people do', () => {
    expect(osName('darwin', '15.6.1')).toBe('macOS 15.6.1')
    expect(osName('win32', '10.0.22631')).toBe('Windows 11 (сборка 22631)')
    expect(osName('win32', '10.0.19045')).toBe('Windows 10 (сборка 19045)')
    expect(osName('linux', '6.8.0', 'Ubuntu 24.04.1 LTS')).toBe('Ubuntu 24.04.1 LTS')
    expect(osName('linux', '6.8.0')).toBe('Linux')
  })
})

describe('formatDevice', () => {
  const FACTS: DeviceFacts = {
    platform: 'darwin',
    systemVersion: '15.6.1',
    kernel: '24.6.0',
    arch: 'arm64',
    translated: false,
    cpuModel: 'Apple M2',
    cpuCount: 8,
    memTotal: 16 * 2 ** 30,
    memFree: 5.25 * 2 ** 30,
    uptimeSec: 3 * 86_400 + 4 * 3_600 + 120,
    locale: 'ru',
    timeZone: 'Europe/Moscow',
    displays: [{ width: 1512, height: 982, scale: 2 }],
    engine: 'amneziawg-go v3.1.20260828 — bundled',
    runtime: { electron: '44.4.3', chrome: '144.0.7000.1', node: '24.1.0' }
  }

  it('one line per fact, the system first', () => {
    expect(formatDevice(FACTS).split('\n')).toEqual([
      'Система: macOS 15.6.1',
      'Ядро: 24.6.0',
      'Архитектура: arm64',
      'Процессор: Apple M2, 8 ядер',
      'Память: 16 ГБ, свободно 5,3 ГБ',
      'Система работает: 3 д 4 ч',
      'Язык и часовой пояс: ru, Europe/Moscow',
      'Экран: 1512×982 ×2',
      'Движок: amneziawg-go v3.1.20260828 — bundled',
      'Electron 44.4.3 · Chromium 144.0.7000.1 · Node 24.1.0'
    ])
  })

  it('says emulation, the Linux session, several screens and a short uptime', () => {
    const text = formatDevice({
      ...FACTS,
      platform: 'linux',
      distro: 'Fedora Linux 40',
      translated: true,
      cpuCount: 4,
      uptimeSec: 25 * 60,
      session: 'wayland, GNOME',
      displays: [
        { width: 1920, height: 1080, scale: 1 },
        { width: 2560, height: 1440, scale: 1.5 }
      ]
    })
    expect(text).toContain('Система: Fedora Linux 40')
    expect(text).toContain('Архитектура: arm64 (x64 в эмуляции)')
    expect(text).toContain('4 ядра')
    expect(text).toContain('Система работает: 25 мин')
    expect(text).toContain('Сеанс: wayland, GNOME')
    expect(text).toContain('Экран: 1920×1080; 2560×1440 ×1.5')
  })
})

describe('device: disk and processor load', () => {
  const BASE: DeviceFacts = {
    platform: 'win32',
    systemVersion: '10.0.22631',
    kernel: '10.0.22631',
    arch: 'x64',
    translated: false,
    cpuModel: 'Intel Core i5',
    cpuCount: 4,
    memTotal: 8 * 2 ** 30,
    memFree: 2 * 2 ** 30,
    uptimeSec: 7_200,
    locale: 'ru',
    timeZone: 'Europe/Moscow',
    displays: [],
    engine: 'служба SenAWG',
    runtime: { electron: '44', chrome: '144', node: '24' }
  }

  it('the disk, and the load on average over the half hour and over the last minute', () => {
    const text = formatDevice({
      ...BASE,
      disk: { total: 494 * 2 ** 30, free: 245.4 * 2 ** 30 },
      cpuLoad: { average: 0.234, minutes: 30, recent: 0.41 }
    })
    expect(text).toContain('Загрузка процессора: в среднем 23% за 30 мин, за последнюю минуту 41%')
    expect(text).toContain('Диск: свободно 245,4 ГБ из 494 ГБ')
    // Right after the memory: what is loaded and how full, together.
    const lines = text.split('\n')
    expect(lines.indexOf('Память: 8 ГБ, свободно 2 ГБ') + 1).toBe(lines.findIndex((l) => l.startsWith('Загрузка процессора')))
  })

  it('a shorter history says how long it covers; none yet — the one reading there is', () => {
    expect(formatDevice({ ...BASE, cpuLoad: { average: 0.5, minutes: 12, recent: 0.2 } })).toContain('в среднем 50% за 12 мин, за последнюю минуту 20%')
    expect(formatDevice({ ...BASE, cpuLoad: { average: 0.5, minutes: 1, recent: 0.5 } })).toContain('Загрузка процессора: в среднем 50% за 1 мин\n')
    expect(formatDevice({ ...BASE, cpuLoad: { average: 0.07, minutes: 0, recent: null } })).toContain('Загрузка процессора: 7% сейчас')
  })

  it('leaves out what could not be read', () => {
    const text = formatDevice(BASE)
    expect(text).not.toContain('Диск')
    expect(text).not.toContain('Загрузка процессора')
  })
})

describe('cpuBusyShare', () => {
  const t = (user: number, sys: number, idle: number): CpuTimes => ({ user, nice: 0, sys, idle, irq: 0 })

  it('the share of all cores\' time not spent idle between two readings', () => {
    // Core 1: 30 busy of 100; core 2: 10 busy of 100 → 40 of 200.
    expect(cpuBusyShare([t(100, 50, 1000), t(0, 0, 0)], [t(120, 60, 1070), t(5, 5, 90)])).toBeCloseTo(0.2)
  })

  it('null when nothing passed or the cores changed', () => {
    expect(cpuBusyShare([t(1, 1, 1)], [t(1, 1, 1)])).toBeNull()
    expect(cpuBusyShare([t(1, 1, 1)], [t(2, 2, 2), t(0, 0, 0)])).toBeNull()
    expect(cpuBusyShare([], [])).toBeNull()
  })
})
