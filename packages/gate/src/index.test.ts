import { expect, it } from "vitest"
import * as gate from "./index"

it("exports only the intent API and audit clients", () => {
  expect(Object.keys(gate).sort()).toEqual([
    "GateRequestError",
    "GateUnavailableError",
    "createAuditClient",
    "createIntentClient",
  ])
})
