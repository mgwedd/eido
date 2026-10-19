import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let mounted: { root: Root; container: HTMLElement }[] = []

export function mount(ui: React.ReactNode) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(ui)
  })
  mounted.push({ root, container })
  return container
}

export function cleanup() {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted = []
  document.body.innerHTML = ""
}

export function slots() {
  return new Set(
    Array.from(document.querySelectorAll("[data-slot]")).map((el) =>
      el.getAttribute("data-slot")
    )
  )
}

export function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>()
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  })) as unknown as typeof window.matchMedia
  return listeners
}
