import { ForbiddenView } from "@/components/forbidden-view"
import { forbiddenReason } from "@/lib/auth/access"
import { auth0 } from "@/lib/auth0"

/** Rendered with HTTP 403 wherever `forbidden()` is called. */
export default async function Forbidden() {
  const session = auth0 ? await auth0.getSession() : null
  return (
    <ForbiddenView reason={session ? forbiddenReason(session.user) : null} />
  )
}
