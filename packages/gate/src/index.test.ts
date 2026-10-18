import { expect, test } from "vitest"
import { GATE_API_VERSION } from "./index"

test("gate package loads", () => {
  expect(GATE_API_VERSION).toBe(0)
})
