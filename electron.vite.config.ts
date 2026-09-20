import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    define: { __APP_VERSION__: JSON.stringify(process.env['npm_package_version'] ?? '0.0.0') },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
