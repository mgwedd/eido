import { expect, test } from "vitest"
import { SCHEMA_VERSION } from "./index"

test("schemas package loads", () => {
  expect(SCHEMA_VERSION).toBe(0)
})
