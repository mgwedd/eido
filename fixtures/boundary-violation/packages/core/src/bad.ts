// Deliberately breaks rule 1: core reaches into gate internals.
// CI asserts that dependency-cruiser fails on this file.
import { TOKEN_STORE_PLACEHOLDER } from "../../gate/src/internal/token-store"

export const leaked = TOKEN_STORE_PLACEHOLDER
