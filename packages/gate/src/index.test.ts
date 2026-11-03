import { expect, it } from "vitest"
import * as gate from "./index"

it("exports only the intent API, audit and read-only mail/file clients", () => {
  expect(Object.keys(gate).sort()).toEqual([
    "GateRequestError",
    "GateUnavailableError",
    "createAuditClient",
    "createFileClient",
    "createIntentClient",
    "createProtonMailClient",
  ])
})
