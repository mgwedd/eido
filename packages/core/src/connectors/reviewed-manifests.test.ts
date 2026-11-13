import { describe, expect, it } from "vitest"
import { REVIEWED_MANIFESTS } from "@eido/schemas"
import { currentManifest, MANIFEST_CONNECTORS } from "./current-manifest"

// ADR 0009, decision 7: the gate pins the committed JSON in @eido/schemas, never core's source.
// This fails when a connector's manifest changes in core without the reviewed copy, so the
// change and its review land in the same pull request. Fix: write the printed manifest to
// packages/schemas/manifests/<name>.json (`pnpm --filter @eido/core connector-manifest <name>`).
// Proton and SimpleFIN build theirs from the environment, so the committed copy is only valid if
// no owner-specific value reaches the manifest: the first two cases below prove that.
const ENV = {
  EIDO_PROTON_USERNAME: "assistant@example.invalid",
  EIDO_PROTON_CALENDAR_ASSISTANT_ADDRESS: "assistant@example.invalid",
  EIDO_PROTON_CALENDAR_OWNER_ADDRESS: "owner@example.invalid",
}
const OTHER_OWNER = {
  EIDO_PROTON_USERNAME: "someone.else@example.com",
  EIDO_PROTON_CALENDAR_ASSISTANT_ADDRESS: "bot@example.com",
  EIDO_PROTON_CALENDAR_OWNER_ADDRESS: "person@example.com",
}

describe("reviewed manifests", () => {
  it.each(MANIFEST_CONNECTORS)("%s matches core's current manifest", (name) => {
    const current = currentManifest(name, ENV)
    expect(current.ok && current.manifest).toEqual(REVIEWED_MANIFESTS[name])
  })

  it.each(["proton-mail", "proton-calendar"])(
    "%s declares the same manifest for any owner's addresses",
    (name) => {
      const mine = currentManifest(name, ENV)
      const theirs = currentManifest(name, OTHER_OWNER)
      expect(mine.ok && theirs.ok && theirs.manifest).toEqual(
        mine.ok && mine.manifest
      )
    }
  )

  it("simplefin's committed copy is the default budget, not a configured one", () => {
    const lower = currentManifest("simplefin", {
      EIDO_SIMPLEFIN_REQUESTS_PER_DAY: "6",
    })
    expect(lower.ok && lower.manifest).not.toEqual(
      REVIEWED_MANIFESTS["simplefin"]
    )
  })
})
