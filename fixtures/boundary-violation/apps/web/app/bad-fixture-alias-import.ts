// Violation: app code imports a test fixture through the "@/" path alias.
import { reachabilityProbes } from "@/test/fixtures/reachability"

export const leaked = reachabilityProbes
