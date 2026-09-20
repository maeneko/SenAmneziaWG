/** What the ping button shows, from «never measured» to a number. */
export interface PingModel {
  /** undefined: not measured yet. null: nothing answered. */
  ms: number | null | undefined
  busy: boolean
  /** Only while the tunnel is up: with it down the number would be about the provider, not the server. */
  enabled: boolean
  check: () => void
}

/** What the bar shows: nothing before the first measurement, then the wait, then the answer. */
export const pingText = (ping: PingModel): string | null =>
  ping.busy ? '…' : ping.ms === undefined ? null : ping.ms === null ? 'нет ответа' : `${ping.ms} мс`
