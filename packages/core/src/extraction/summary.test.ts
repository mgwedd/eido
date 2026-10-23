import { expect, test } from "vitest"
import { summarize } from "./summary"

const base = {
  status: "ok" as const,
  proposed: 4,
  verified: 1,
  needsConfirmation: 2,
  dropped: 1,
  passagesRead: 3,
  passagesTotal: 3,
}

test("plural confirmations, drops and no passage note when every passage was read", () => {
  expect(summarize(base)).toBe(
    "1 of 4 verified; 2 need confirmation; 1 dropped"
  )
})

test("statuses other than ok have fixed lines", () => {
  expect(summarize({ ...base, status: "no_candidates" })).toBe(
    "no candidate passages"
  )
  expect(summarize({ ...base, status: "model_output_rejected" })).toBe(
    "model output rejected after one corrective retry"
  )
  expect(
    summarize({ ...base, status: "refused_over_budget", passagesRead: 0 })
  ).toBe("refused: over the token budget; read 0 of 3 passages")
})
