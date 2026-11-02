import type { Metadata } from "next"
import { AskView } from "@/components/ask-view"

export const metadata: Metadata = { title: "Ask · Eido" }

export default function AskPage() {
  return <AskView />
}
