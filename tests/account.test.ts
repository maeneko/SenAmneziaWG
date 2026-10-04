import { describe, expect, it } from 'vitest'
import { accountName, hasAccessToken } from '../src/shared/account'

describe('account', () => {
  it('splits the access token off the login', () => {
    expect(accountName('ma7_3f9a1c.7K3MQX9P2HWDR4TN')).toBe('ma7_3f9a1c')
    expect(hasAccessToken('ma7_3f9a1c.7K3MQX9P2HWDR4TN')).toBe(true)
  })

  it('an old login without a token stays as it is', () => {
    expect(accountName('ma7_3f9a1c')).toBe('ma7_3f9a1c')
    expect(hasAccessToken('ma7_3f9a1c')).toBe(false)
  })
})
