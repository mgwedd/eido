// Deliberately breaks gate-imports-schemas-only: the gate reaches into the data plane.
// CI asserts that dependency-cruiser fails on this file.
import { DATA_PLANE } from "../../core/src/index"

export const reached = DATA_PLANE
