// Deliberately breaks rule 1 through a workspace specifier instead of a relative path.
// Resolution fails here because the fixture has no node_modules, so not-to-unresolvable fires.
import { TOKEN_STORE_PLACEHOLDER } from "@eido/gate/src/internal/token-store"

export const leakedViaWorkspace = TOKEN_STORE_PLACEHOLDER
