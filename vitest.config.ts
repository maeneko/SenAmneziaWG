import { configDefaults, defineConfig } from 'vitest/config'

// awg.sh is the macOS helper: these run bash, perl and BSD route/ifconfig stubs.
const MACOS_ONLY = ['tests/awgScript.test.ts', 'tests/awgUpDown.test.ts']

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...(process.platform === 'darwin' ? [] : MACOS_ONLY)]
  }
})
