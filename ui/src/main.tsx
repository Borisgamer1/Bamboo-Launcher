import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyLauncherFont, readLauncherFont } from './lib/launcherFont'
import { installTauriBridge } from './lib/tauriBridge'

// The ported UI talks to electronAPI; Tauri provides that surface.
installTauriBridge()

// WebView2 opens its own page menu (back, refresh, print, inspect) on a right
// click, which a launcher has no use for. Text fields keep the native menu so
// cut/copy/paste still works where it is expected.
window.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement | null
  if (!target?.closest('input, textarea, [contenteditable="true"]')) {
    event.preventDefault()
  }
})

// Apply the saved face before React paints so a chosen font never starts as the
// default for one frame. The hook keeps it in sync afterwards.
try {
  applyLauncherFont(readLauncherFont(window.localStorage))
} catch {
  applyLauncherFont('normal')
}

// A window can outlive a rebuild: its old index references a hashed chunk that
// no longer exists, so the lazy import dead-ends. Reload once to pick up the
// current index; the timestamp guard prevents a reload loop if it is really gone.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  try {
    const key = 'bamboo:preload-reload'
    const last = Number(window.sessionStorage.getItem(key) || 0)
    if (Date.now() - last < 15_000) return
    window.sessionStorage.setItem(key, String(Date.now()))
  } catch {
    // Without session storage the reload is still the best attempt.
  }
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
