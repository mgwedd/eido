import { ForbiddenView } from "@/components/forbidden-view"
import { forbiddenReason } from "@/lib/auth/access"
import { auth0 } from "@/lib/auth0"

/** Rendered with HTTP 403 wherever `forbidden()` is called. */
export default async function Forbidden() {
  const session = await auth0.getSession()
  return (
    <ForbiddenView reason={session ? forbiddenReason(session.user) : null} />
  )
}
