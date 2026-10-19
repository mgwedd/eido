import { expect, test } from "vitest"
import * as core from "./index"
import { openIndex } from "./index/index"
import { createProfileStore } from "./profile/index"

test("the core entry point re-exports the index and profile modules", () => {
  expect(core.openIndex).toBe(openIndex)
  expect(core.createProfileStore).toBe(createProfileStore)
})
