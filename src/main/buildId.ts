/** The channel this build belongs to. One line to change when releases start. */
const CHANNEL = 'beta'

/**
 * How a build names itself: «{channel}-{version}-{os}», e.g. beta-0.1.0-mac. Shown in
 * «Об SenAWG», so a bug report says which build it came from.
 */
export function buildId(version: string, platform: NodeJS.Platform = process.platform): string {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
  return `${CHANNEL}-${version}-${os}`
}
