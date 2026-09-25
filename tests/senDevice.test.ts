import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/store', () => ({ readData: () => ({}), writeData: () => {} }))
const { nameFromUser } = await import('../src/main/sen/device')

describe('nameFromUser', () => {
  it('takes the first name only: the surname is not the operator\'s business', () => {
    expect(nameFromUser('Иван Васильев', 'MacBook-Pro.local')).toBe('Иван')
    expect(nameFromUser('  Ivan   V. Vasilev ', 'h')).toBe('Ivan')
  })

  it('takes an account name as it is', () => {
    expect(nameFromUser('ribm', 'h')).toBe('ribm')
  })

  it('strips what would only be noise in a list', () => {
    expect(nameFromUser('<b>Ivan</b> X', 'h')).toBe('bIvanb')
    expect(nameFromUser('Ann\u0000e Y', 'h')).toBe('Anne')
  })

  it('falls back to the computer\'s name, without «.local», when the system says nothing', () => {
    expect(nameFromUser('', 'MacBook-Pro.local')).toBe('MacBook-Pro')
    expect(nameFromUser('   ', 'desktop')).toBe('desktop')
    expect(nameFromUser('!!!', 'desktop')).toBe('desktop')
  })

  it('never returns an empty name', () => {
    expect(nameFromUser('', '')).toBe('SenAWG')
  })

  it('cuts a very long name', () => {
    expect(nameFromUser('x'.repeat(100), 'h')).toHaveLength(32)
  })
})
