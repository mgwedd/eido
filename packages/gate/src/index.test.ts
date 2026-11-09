import { expect, it } from "vitest"
import * as gate from "./index"

it("exports only the intent API, audit, mail/file clients, and web session verification", () => {
  expect(Object.keys(gate).sort()).toEqual([
    "GateRequestError",
    "GateUnavailableError",
    "SESSION_COOKIE",
    "SESSION_COOKIE_PATH",
    "WEB_SESSION_COOKIE",
    "WEB_SESSION_COOKIE_PATH",
    "WEB_SESSION_TTL_MS",
    "clearGateSessionCookie",
    "clearWebSessionCookie",
    "createAuditClient",
    "createFileClient",
    "createIntentClient",
    "createProtonMailClient",
    "createThingsClient",
    "generateWebSessionKeyPair",
    "getWebSessionPublicKey",
    "publicKeyFromRaw",
    "verifyWebSession",
    "webSessionCookie",
  ])
})
