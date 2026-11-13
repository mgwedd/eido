// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest"
import { cleanup, mount } from "../test-utils"
import { Progress } from "./progress"

afterEach(cleanup)

test("Progress is a progressbar that reports its value and fills the track to it", () => {
  mount(<Progress value={40} aria-label="Recovery delay" />)
  const bar = document.querySelector('[role="progressbar"]')
  expect(bar?.getAttribute("aria-valuenow")).toBe("40")
  expect(bar?.getAttribute("aria-label")).toBe("Recovery delay")
  const indicator = document.querySelector('[data-slot="progress-indicator"]')
  expect((indicator as HTMLElement).style.width).toBe("40%")
})
