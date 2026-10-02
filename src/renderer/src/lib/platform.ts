/// <reference types="vite/client" />
/** The UI lab (src/renderer/demo/lab.html) plays a platform with ?platform=; dropped from the build. */
const played = import.meta.env.DEV ? new URLSearchParams(location.search).get('platform') : null

/** Read from the user agent: the renderer needs it synchronously, before the first paint. */
export const isLinux = played ? played === 'linux' : /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)
export const isMac = played ? played === 'mac' : /Macintosh|Mac OS X/.test(navigator.userAgent)
