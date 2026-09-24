import type { KeyVault } from '../../store'
import type { HelperClient } from '../windows/helperClient'

/**
 * Tunnel keys kept by the SenAWG service (helper/internal/vault) for a desktop with no Secret Service or
 * KWallet: root-only files under /var/lib/senawg/secrets, per user (the service takes the uid from the
 * socket, not from here). Keys only ever go in; `up` has the service add them itself.
 */
export function serviceVault(client: HelperClient): KeyVault {
  return {
    async put(id, secrets) {
      await client.request({ op: 'secret-put', id, privateKey: secrets.privateKey, presharedKey: secrets.presharedKey })
    },
    async delete(id) {
      await client.request({ op: 'secret-delete', id })
    }
  }
}
