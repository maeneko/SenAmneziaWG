import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import './styles/remove.css'
import './styles/update.css'
import App from './App'
import { isMac } from './lib/platform'

document.documentElement.dataset.platform = isMac ? 'mac' : 'other'

const start = (): void =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )

// Opened in a browser from `vite dev` (src/renderer/demo/): no preload, so a made-up bridge plays a scenario.
// The whole branch is dropped from the build.
if (import.meta.env.DEV && !('awg' in window)) void import('./demo/bridge').then(start)
else start()
