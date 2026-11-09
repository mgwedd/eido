import type { Metadata } from "next"
import { forbidden, redirect } from "next/navigation"

import { forbiddenReason } from "@/lib/auth/access"
import { auth0 } from "@/lib/auth0"

export const metadata: Metadata = { title: "No access" }
export const dynamic = "force-dynamic"

/**
 * The proxy rewrites refused page requests here. `forbidden()` renders app/forbidden.tsx with
 * HTTP 403; a rewrite in the proxy cannot carry the status itself.
 */
export default async function ForbiddenPage(): Promise<never> {
  const session = auth0 ? await auth0.getSession() : null
  if (!session) redirect(auth0 ? "/auth/login" : "/unlock")
  if (forbiddenReason(session.user) === null) redirect("/")
  forbidden()
}
