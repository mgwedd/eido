import type { Metadata } from "next"

import { RecoverView } from "@/components/recover-view"

export const metadata: Metadata = { title: "Recover" }

export default function RecoverPage() {
  return <RecoverView />
}
