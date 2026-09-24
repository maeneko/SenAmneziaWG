import { describe, expect, it, vi } from 'vitest'
import { serviceVault } from '../src/main/tunnel/linux/serviceVault'
import type { HelperClient } from '../src/main/tunnel/windows/helperClient'
import type { HelperRequest } from '../src/main/tunnel/windows/protocol'

function fakeClient() {
  const calls: HelperRequest[] = []
  const request = vi.fn(async (req: HelperRequest) => {
    calls.push(req)
    return { ok: true }
  })
  return { client: { request } as unknown as HelperClient, calls }
}

describe('serviceVault', () => {
  it('hands the keys to the service as they are in the .conf', async () => {
    const { client, calls } = fakeClient()
    await serviceVault(client).put('t-1', { privateKey: 'cHJpdg==', presharedKey: 'cHNr' })
    expect(calls).toEqual([{ op: 'secret-put', id: 't-1', privateKey: 'cHJpdg==', presharedKey: 'cHNr' }])
  })

  it('forgets them by id', async () => {
    const { client, calls } = fakeClient()
    await serviceVault(client).delete('t-1')
    expect(calls).toEqual([{ op: 'secret-delete', id: 't-1' }])
  })
})
