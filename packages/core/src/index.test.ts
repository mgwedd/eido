import { expect, test } from "vitest"
import { CORE_GATE_API_VERSION } from "./index"

test("core package loads", () => {
  expect(CORE_GATE_API_VERSION).toBe(0)
})
