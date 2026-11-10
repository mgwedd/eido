import { clearCachedTransactions } from "@/lib/transactions"
import { clearDraft } from "@/lib/file-roots-draft"

/**
 * Removes the user data this browser keeps between visits (the SimpleFIN transaction list in
 * localStorage, the edited file-roots list in sessionStorage). Run on sign-out, lock and
 * session expiry so a shared or lost phone does not hold the previous session's data.
 */
export function clearUserCaches(): void {
  clearCachedTransactions()
  clearDraft()
}
