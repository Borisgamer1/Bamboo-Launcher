/**
 * Screenshot cards load their image only once they reach the viewport. The tab
 * used to pull every file through IPC as a base64 data URL on mount, so the
 * renderer's memory grew with the whole library. This keeps the reads
 * proportional to what the user actually looks at; nothing is dropped from the
 * list, cards just start without an image.
 *
 * Pure DOM logic (no React, no observer construction) so it can be executed in
 * node tests with a real jsdom tree and a fake observer.
 */
export const SCREENSHOT_ID_ATTR = 'data-screenshot-id'
export const SCREENSHOT_PATH_ATTR = 'data-screenshot-path'

export interface VisibilityEntry {
  isIntersecting: boolean
  target: Element
}

export interface CardObserver {
  observe(target: Element): void
  unobserve(target: Element): void
  disconnect(): void
}

/**
 * One request per screenshot, whatever asks for it: the viewport observer, the
 * lightbox or a click. A failed read is forgotten so the next attempt can
 * retry; the loaded data URL is handed to the caller's state.
 */
export interface ScreenshotRequests {
  request(id: string, path: string): void
  forget(id: string): void
  reset(): void
  has(id: string): boolean
}

export function createScreenshotRequests(options: {
  load: (path: string) => Promise<string | null>
  onLoad: (id: string, dataUrl: string) => void
}): ScreenshotRequests {
  const requested = new Set<string>()
  return {
    request(id, path) {
      if (!id || !path || requested.has(id)) return
      requested.add(id)
      options.load(path).then(
        (dataUrl) => {
          if (dataUrl) options.onLoad(id, dataUrl)
          else requested.delete(id)
        },
        () => { requested.delete(id) },
      )
    },
    forget(id) { requested.delete(id) },
    reset() { requested.clear() },
    has(id) { return requested.has(id) },
  }
}

export function watchScreenshotCards(options: {
  root: ParentNode | null
  createObserver: (onEntries: (entries: VisibilityEntry[]) => void) => CardObserver
  onVisible: (id: string, path: string) => void
}): CardObserver | null {
  if (!options.root) return null

  let observer: CardObserver | null = null
  observer = options.createObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const card = entry.target
      // One request per card: after it has been seen it never needs re-observing.
      observer?.unobserve(card)
      const id = card.getAttribute(SCREENSHOT_ID_ATTR)
      const path = card.getAttribute(SCREENSHOT_PATH_ATTR)
      if (id && path) options.onVisible(id, path)
    }
  })

  const cards = options.root.querySelectorAll(
    `[${SCREENSHOT_ID_ATTR}][${SCREENSHOT_PATH_ATTR}]`,
  )
  for (const card of cards) {
    if (card.getAttribute(SCREENSHOT_PATH_ATTR)) observer.observe(card)
  }
  return observer
}
