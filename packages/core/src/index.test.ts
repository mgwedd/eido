import { expect, test } from "vitest"
import * as core from "./index"
import { openIndex } from "./index/index"
import { createProfileStore } from "./profile/index"
import { createAccessAuditor } from "./access-audit/index"

test("the core entry point re-exports the index, profile and access-audit modules", () => {
  expect(core.openIndex).toBe(openIndex)
  expect(core.createProfileStore).toBe(createProfileStore)
  expect(core.createAccessAuditor).toBe(createAccessAuditor)
})
