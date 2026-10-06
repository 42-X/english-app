import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { installAudioUnlock } from './audio/engine'
import './index.css'

document.documentElement.dataset.build = __BUILD__
installAudioUnlock()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
