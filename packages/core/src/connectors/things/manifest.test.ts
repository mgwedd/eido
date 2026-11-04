import { describe, expect, test } from "vitest"
import { validateConnectorManifest } from "@eido/schemas"
import type { IntentClient, ThingsClient } from "@eido/gate"
import {
  CONNECTOR_NAME,
  THINGS_SCOPE,
  observedToolNames,
  policyFor,
  thingsManifest,
} from "./manifest"
import { createThingsFacade } from "./facade"

const manifest = thingsManifest()

describe("Things manifest", () => {
  test("is valid under the pinned manifest schema", () => {
    expect(validateConnectorManifest(manifest)).toMatchObject({ ok: true })
    expect(manifest.name).toBe(CONNECTOR_NAME)
    expect(manifest.auth.type).toBe("macos-automation")
    expect(manifest.auth.scopes).toEqual([THINGS_SCOPE])
    expect(manifest.egress.hosts).toEqual([])
  })

  test("AC 1: declares effect, reversibility, sensitivity, untrusted flag and tier for each verb", () => {
    const table = manifest.operations.map((op) => [
      op.name,
      op.effect,
      op.reversibility,
      op.sensitivity,
      op.untrustedOutput,
      op.defaultTier,
      op.intentKind ?? null,
    ])
    expect(table).toEqual([
      ["list_todos", "read", "reversible", "sensitive", true, "auto", null],
      ["get_todo", "read", "reversible", "sensitive", true, "auto", null],
      ["list_deadline", "read", "reversible", "sensitive", true, "auto", null],
      ["list_projects", "read", "reversible", "sensitive", true, "auto", null],
      ["get_project", "read", "reversible", "sensitive", true, "auto", null],
      ["list_areas", "read", "reversible", "sensitive", true, "auto", null],
      ["list_tags", "read", "reversible", "sensitive", true, "auto", null],
      [
        "add_todo",
        "write",
        "reversible",
        "sensitive",
        false,
        "auto",
        "things.add_todo",
      ],
      [
        "update_todo",
        "write",
        "reversible",
        "sensitive",
        false,
        "approval",
        "things.update_todo",
      ],
      [
        "schedule_todo",
        "write",
        "reversible",
        "sensitive",
        false,
        "approval",
        "things.schedule_todo",
      ],
      [
        "complete_todo",
        "write",
        "reversible",
        "sensitive",
        false,
        "approval",
        "things.complete_todo",
      ],
      [
        "cancel_todo",
        "write",
        "reversible",
        "sensitive",
        false,
        "approval",
        "things.cancel_todo",
      ],
      [
        "add_project",
        "write",
        "reversible",
        "sensitive",
        false,
        "approval",
        "things.add_project",
      ],
    ])
  })

  test("AC 1: facade verbs and manifest operations are the same set (fails if missing from either side)", () => {
    const fakeClient = {} as ThingsClient
    const fakeIntents = {
      propose: () =>
        Promise.resolve({
          id: "1",
          tier: "auto" as const,
          state: "proposed" as const,
        }),
    } as unknown as IntentClient
    const facade = createThingsFacade({
      client: fakeClient,
      intents: fakeIntents,
    })

    const facadeVerbs = Object.keys(facade).sort()
    const manifestVerbs = manifest.operations.map((op) => op.name).sort()

    expect(facadeVerbs).toEqual(manifestVerbs)
  })

  test("observedToolNames extracts tool names and ignores invalid entries", () => {
    expect(
      observedToolNames([
        { name: "list_todos" },
        null,
        "invalid",
        { other: 123 },
        { name: "add_todo" },
      ])
    ).toEqual(["list_todos", "add_todo"])
    expect(observedToolNames(null)).toEqual([])
  })

  test("policyFor returns operation or undefined", () => {
    expect(policyFor(manifest, "add_todo")?.intentKind).toBe("things.add_todo")
    expect(policyFor(manifest, "non_existent")).toBeUndefined()
  })
})
