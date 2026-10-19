import { expect, test } from "vitest"
import { TOKEN_STORE_PLACEHOLDER } from "./token-store"

test("token store module loads", () => {
  expect(TOKEN_STORE_PLACEHOLDER).toBe(true)
})
