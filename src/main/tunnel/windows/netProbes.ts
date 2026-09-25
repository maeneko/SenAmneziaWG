import type { NetProbes } from '../healthCheck'
import type { HelperClient } from './helperClient'

/** The service asks Windows directly (routing table, adapter DNS settings), so nothing is parsed from command output. */
export function helperNetProbes(client: HelperClient): NetProbes {
  return {
    routeInterface: async (ip) => (await client.request({ op: 'netinfo', target: ip })).routeIface || null,
    primaryResolver: async () => {
      const { resolver } = await client.request({ op: 'netinfo', target: '1.1.1.1' })
      // Windows has no reachability flag per resolver, unlike scutil.
      return resolver ? { iface: resolver.iface ?? '', nameservers: resolver.nameservers, reachable: true } : null
    }
  }
}
