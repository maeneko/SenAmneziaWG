/**
 * What comes after «#» in a sen:// link. MA7 used to put just the login there (`ma7_3f9a1c`); now it adds the
 * account's access token after a dot (`ma7_3f9a1c.7K3MQX9P2HWDR4TN`). The whole string is kept and sent to MA7
 * as the login, which is how it tells the owner apart: without a token it refuses promo codes, payment and reports.
 */

/** The login alone, for showing and copying: the token never goes on screen. */
export function accountName(login: string): string {
  const dot = login.indexOf('.')
  return dot > 0 ? login.slice(0, dot) : login
}

/** Whether the link carried an access token — the key to promo codes, payment and reports. */
export function hasAccessToken(login: string): boolean {
  return accountName(login) !== login
}
