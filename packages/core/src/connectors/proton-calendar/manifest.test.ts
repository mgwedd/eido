import { describe, expect, it } from "vitest"
import { validateConnectorManifest } from "@eido/schemas"
import {
  CONNECTOR_NAME,
  observedToolNames,
  policyFor,
  protonCalendarManifest,
} from "./manifest"
import { createProtonCalendarFacade } from "./facade"

describe("Proton Calendar Manifest", () => {
  const config = {
    bridgeHost: "127.0.0.1",
    smtpPort: 1025,
    assistantAddress: "assistant@astrealabs.com",
    ownerAddress: "owner@astrealabs.com",
  }

  it("declares effect, reversibility, sensitivity, untrusted flag, tier and egress", () => {
    const m = protonCalendarManifest(config)
    const validated = validateConnectorManifest(m)
    expect(validated.ok, "manifest conforms to ConnectorManifest schema").toBe(
      true
    )

    expect(m.name).toBe(CONNECTOR_NAME)
    expect(m.auth).toEqual({
      type: "password",
      scopes: ["bridge-password"],
    })

    // Egress is Bridge host and SMTP port only; no external HTTP egress
    expect(m.egress.hosts).toEqual([])
    expect(m.egress.local).toEqual([
      { protocol: "smtp", host: "127.0.0.1", port: 1025 },
    ])

    // No triggers in MVP
    expect(m.triggers).toEqual([])

    for (const op of m.operations) {
      expect(op.effect).toBe("write")
      expect(op.reversibility).toBe("reversible")
      expect(op.sensitivity).toBe("sensitive")
      expect(op.untrustedOutput).toBe(false)
      expect(op.defaultTier).toBe("auto")
      expect(op.authScopes).toEqual(["bridge-password"])
    }
  })

  it("fails if a facade verb is missing from the manifest", () => {
    const m = protonCalendarManifest(config)
    const facade = createProtonCalendarFacade({
      config,
      intents: {
        propose: () =>
          Promise.resolve({ id: "dummy", tier: "auto", state: "proposed" }),
        restoreTrash: () =>
          Promise.resolve({
            id: "dummy",
            tier: "approval",
            state: "proposed",
          }),
        status: () =>
          Promise.resolve({
            id: "dummy",
            kind: "calendar.create" as const,
            edited_from: null,
            discarded: false,
            state: "proposed" as const,
            tier: "auto" as const,
          }),
        history: () => Promise.resolve([]),
        listPending: () => Promise.resolve([]),
        getConnectorHealth: () => Promise.resolve([]),
      },
    })

    const facadeVerbs = Object.keys(facade)
    expect(facadeVerbs).toEqual([
      "event_create",
      "event_update",
      "event_delete",
    ])

    const manifestOpNames = m.operations.map((op) => op.name)

    // Every facade verb must be declared in manifest
    for (const verb of facadeVerbs) {
      expect(
        manifestOpNames,
        `manifest must declare facade verb ${verb}`
      ).toContain(verb)
      const op = policyFor(m, verb)
      expect(op).toBeDefined()
      expect(op?.name).toBe(verb)
    }

    // Verify test fails if an operation is missing
    const incompleteManifest = {
      ...m,
      operations: m.operations.filter((op) => op.name !== "event_delete"),
    }
    const missingVerb = facadeVerbs.find(
      (verb) => !incompleteManifest.operations.some((op) => op.name === verb)
    )
    expect(missingVerb).toBe("event_delete")
  })

  it("observedToolNames returns tool names from listing", () => {
    const tools = [
      { name: "event_create" },
      { name: "event_update" },
      { dummy: 1 },
    ]
    expect(observedToolNames(tools)).toEqual(["event_create", "event_update"])
    expect(observedToolNames(null)).toEqual([])
    expect(observedToolNames("not an array")).toEqual([])
  })
})
