import { describe, expect, test } from "vitest"
import * as ThingsIndex from "./index"

describe("Things connector index re-exports", () => {
  test("exports manifest, facade and sync", () => {
    expect(ThingsIndex.thingsManifest).toBeDefined()
    expect(ThingsIndex.THINGS_CONNECTOR_NAME).toBe("things")
    expect(ThingsIndex.THINGS_SCOPE).toBe("Things3")
    expect(ThingsIndex.thingsObservedToolNames).toBeDefined()
    expect(ThingsIndex.thingsPolicyFor).toBeDefined()
    expect(ThingsIndex.createThingsFacade).toBeDefined()
    expect(ThingsIndex.syncThingsTodos).toBeDefined()
    expect(ThingsIndex.THINGS_CONNECTOR).toBe("things")
    expect(ThingsIndex.THINGS_STREAM).toBe("todos")
    expect(ThingsIndex.THINGS_MIME).toBe("application/x-eido-things-todo")
  })
})
