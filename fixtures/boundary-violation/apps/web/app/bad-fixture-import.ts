// Violation: app code imports a test fixture.
import { reachabilityProbes } from "../test/fixtures/reachability"

export const leaked = reachabilityProbes
