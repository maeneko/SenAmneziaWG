/** Read from the user agent: the renderer needs it synchronously, before the first paint. */
export const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent)
