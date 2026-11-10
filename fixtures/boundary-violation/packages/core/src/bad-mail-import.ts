// Deliberately breaks mail-and-keychain-libs-are-gate-only: core imports a mail library.
// CI asserts that dependency-cruiser fails on this file.
import { ImapFlow } from "imapflow"

export const mail = ImapFlow
