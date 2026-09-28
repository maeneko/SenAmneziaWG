import { resolve } from 'node:path'
import type { UserConfig } from 'vite'
import config from './electron.vite.config'

// `npm run demo`: the renderer alone, in a browser, for the harnesses in src/renderer/demo/ — the UI lab
// (lab.html) and the macOS update (mac-update.html) — with the same renderer settings as the application's
// build, served from where electron-vite serves them.
const renderer = (config as { renderer: UserConfig }).renderer

const demo: UserConfig = {
  ...renderer,
  // The version the page shows is the one the demo is playing — the old copy, then the new one — so
  // __APP_VERSION__ is left a plain global that the bridges in src/renderer/src/demo/ set; the build's
  // own version goes to them under another name.
  define: { __BUILD_VERSION__: renderer.define?.['__APP_VERSION__'] },
  root: resolve('src/renderer'),
  server: { port: 5199, open: '/demo/lab.html' }
}
export default demo
