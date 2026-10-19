// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest"
import { cleanup, mount, stubMatchMedia } from "../test-utils"
import { useIsMobile } from "./use-mobile"

afterEach(cleanup)

function Probe() {
  return <span>{useIsMobile() ? "mobile" : "desktop"}</span>
}

test("reports mobile when the media query matches and unsubscribes on unmount", () => {
  const listeners = stubMatchMedia(true)
  mount(<Probe />)
  expect(document.body.textContent).toBe("mobile")
  expect(listeners.size).toBe(1)
  cleanup()
  expect(listeners.size).toBe(0)
})

test("reports desktop when the media query does not match", () => {
  stubMatchMedia(false)
  mount(<Probe />)
  expect(document.body.textContent).toBe("desktop")
})
