import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { ForbiddenView } from "@/components/forbidden-view"
import { forbiddenReason } from "@/lib/auth/access"
import { auth0 } from "@/lib/auth0"

export const metadata: Metadata = { title: "No access" }
export const dynamic = "force-dynamic"

export default async function ForbiddenPage() {
  const session = await auth0.getSession()
  if (!session) redirect("/auth/login")
  const reason = forbiddenReason(session.user)
  if (reason === null) redirect("/")
  return <ForbiddenView reason={reason} />
}
