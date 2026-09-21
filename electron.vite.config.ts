import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// The one place the version is set is package.json: electron-builder names the build after it, the main
// process reads it back as app.getVersion(), scripts/build-helper-win.mjs stamps it into the service, and
// the renderer gets it here — from the file, so it is right however Vite was started, not only via npm.
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [react()],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        // Two pages: the application, and the setup screen the downloaded installer opens (src/main/setup).
        input: {
          index: resolve('src/renderer/index.html'),
          installer: resolve('src/renderer/installer/index.html')
        }
      }
    },
    define: { __APP_VERSION__: JSON.stringify(version) },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
