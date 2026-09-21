import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import './styles/remove.css'
import App from './App'
import { isMac } from './lib/platform'

document.documentElement.dataset.platform = isMac ? 'mac' : 'other'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
