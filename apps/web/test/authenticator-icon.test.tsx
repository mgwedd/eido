// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AuthenticatorIcon } from "@/components/authenticator-icon"
import { stubIphone, stubMac } from "./platform"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.unstubAllGlobals())

function glyph(): string {
  const container = document.createElement("div")
  const root = createRoot(container)
  act(() => root.render(<AuthenticatorIcon />))
  const classes = container.querySelector("svg")?.getAttribute("class") ?? ""
  act(() => root.unmount())
  return classes
}

describe("AuthenticatorIcon", () => {
  it("is the face scan on an iPhone", () => {
    stubIphone()
    expect(glyph()).toContain("lucide-scan-face")
  })

  it("is the passkey key on a Mac", () => {
    stubMac()
    expect(glyph()).toContain("lucide-key-round")
  })

  it("is the passkey key on any other device", () => {
    vi.stubGlobal("navigator", { userAgent: "Windows", maxTouchPoints: 0 })
    expect(glyph()).toContain("lucide-key-round")
  })
})
