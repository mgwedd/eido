// Deliberately breaks infra-uses-public-entry-points-only: infra imports a core internal.
// CI asserts that dependency-cruiser fails on this file.
import { leaked } from "../packages/core/src/bad"

export const internals = leaked
