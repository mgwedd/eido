import { SCHEMA_VERSION } from "@eido/schemas"
import { expect, test } from "vitest"

test("web can import the schemas package", () => {
  expect(SCHEMA_VERSION).toBe(0)
})
