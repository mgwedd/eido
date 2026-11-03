import { vi } from "vitest"

export const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
export const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"

/** Makes the browser report an iPhone until `vi.unstubAllGlobals()`. */
export function stubIphone() {
  vi.stubGlobal("navigator", { userAgent: IPHONE_UA, maxTouchPoints: 5 })
}

/** Makes the browser report a Mac until `vi.unstubAllGlobals()`. */
export function stubMac() {
  vi.stubGlobal("navigator", { userAgent: MAC_UA, maxTouchPoints: 0 })
}
