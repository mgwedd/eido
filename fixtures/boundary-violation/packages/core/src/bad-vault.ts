// Deliberately breaks rule 1: core reaches into the gate token vault.
// CI asserts that dependency-cruiser fails on this file.
import { VAULT_FIXTURE } from "../../gate/src/internal/vault"

export const leakedVault = VAULT_FIXTURE
