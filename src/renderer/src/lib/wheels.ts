/**
 * The wheels of a number turning from `was` to `now`, left to right, as [key, before, after] — '' where one of them
 * has no character. The whole part is matched from the right (units under units), the kopecks from the left of the
 * comma (tenths under tenths): «5 066,67» → «3 800» turns the units of each and rolls «,67» away, rather than
 * putting a digit against the comma. The key names the place, so a wheel stays the same one between changes.
 */
export function wheelPairs(was: string, now: string): [string, string, string][] {
  const split = (text: string): [string[], string[] | null] => {
    const comma = text.indexOf(',')
    return comma < 0 ? [[...text], null] : [[...text.slice(0, comma)], [...text.slice(comma + 1)]]
  }
  const [wasWhole, wasFrac] = split(was)
  const [nowWhole, nowFrac] = split(now)
  const pairs: [string, string, string][] = []
  const whole = Math.max(wasWhole.length, nowWhole.length)
  for (let pos = whole - 1; pos >= 0; pos--) {
    pairs.push([`w${pos}`, wasWhole[wasWhole.length - 1 - pos] ?? '', nowWhole[nowWhole.length - 1 - pos] ?? ''])
  }
  if (wasFrac || nowFrac) {
    pairs.push(['comma', wasFrac ? ',' : '', nowFrac ? ',' : ''])
    const frac = Math.max(wasFrac?.length ?? 0, nowFrac?.length ?? 0)
    for (let pos = 0; pos < frac; pos++) pairs.push([`f${pos}`, wasFrac?.[pos] ?? '', nowFrac?.[pos] ?? ''])
  }
  return pairs
}
