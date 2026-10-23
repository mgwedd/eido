import { describe, expect, test } from "vitest"
import { openDataDb } from "../ledger/db"
import { createProfileStore } from "../profile/store"
import { EntityRequiredError, ingestEntityId } from "./ingest-entity"

async function setup() {
  const profile = createProfileStore(openDataDb(":memory:"), {
    audit: () => Promise.resolve(),
  })
  const assigned = await profile.createEntity({
    kind: "property",
    name: "Test Property",
    tag: "PROP",
  })
  const fallback = await profile.createEntity({
    kind: "personal",
    name: "Test Personal",
    tag: "ME",
  })
  return { profile, assigned, fallback }
}

describe("ingestEntityId", () => {
  test("the account's assignment wins over the default entity", async () => {
    const { profile, assigned, fallback } = await setup()
    await profile.setDefaultEntityId(fallback.id)
    await profile.assignAccount({
      connector: "gmail",
      accountRef: "box@example.invalid",
      entityId: assigned.id,
    })
    expect(
      await ingestEntityId("gmail", {
        accountRef: "box@example.invalid",
        entities: profile,
      })
    ).toBe(assigned.id)
  })

  test("an assignment on another connector does not apply", async () => {
    const { profile, assigned, fallback } = await setup()
    await profile.setDefaultEntityId(fallback.id)
    await profile.assignAccount({
      connector: "proton",
      accountRef: "box@example.invalid",
      entityId: assigned.id,
    })
    expect(
      await ingestEntityId("gmail", {
        accountRef: "box@example.invalid",
        entities: profile,
      })
    ).toBe(fallback.id)
  })

  test("with neither it throws EntityRequiredError naming the connector, not the account", async () => {
    const { profile } = await setup()
    const error = await ingestEntityId("gmail", {
      accountRef: "box@example.invalid",
      entities: profile,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EntityRequiredError)
    expect(error).toMatchObject({ code: "entity_required", connector: "gmail" })
    expect(String(error)).not.toContain("box@example.invalid")
  })
})
