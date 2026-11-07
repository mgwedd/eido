import { describe, expect, it } from "vitest"
import { REVIEWED_MANIFESTS } from "@eido/schemas"
import { currentManifest } from "./current-manifest"

// ADR 0009, decision 7: the gate pins the committed JSON in @eido/schemas, never core's source.
// This fails when a connector's manifest changes in core without the reviewed copy, so the
// change and its review land in the same pull request. Fix: write the printed manifest to
// packages/schemas/manifests/<name>.json (`pnpm --filter @eido/core connector-manifest <name>`).
describe("reviewed manifests", () => {
  it.each(["drive", "files", "gmail", "things"])(
    "%s matches core's current manifest",
    (name) => {
      const current = currentManifest(name, {})
      expect(current.ok && current.manifest).toEqual(REVIEWED_MANIFESTS[name])
    }
  )
})
