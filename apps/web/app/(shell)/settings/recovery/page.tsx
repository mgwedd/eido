import type { Metadata } from "next"

import { RecoveryCancelView } from "@/components/recovery-cancel-view"

export const metadata: Metadata = { title: "Recovery" }

export default function Page() {
  return <RecoveryCancelView />
}
