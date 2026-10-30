import { LogOut } from "lucide-react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import type { ForbiddenReason } from "@/lib/auth/access"

const MESSAGES: Record<ForbiddenReason, string> = {
  unverified:
    "This account's email address isn't verified. Sign in with a verified address.",
  "not-invited": "This account isn't on Eido's allow-list.",
  "owner-only": "This page is only for the person Eido works for.",
}

/** The 403 page: why access was refused, and a way to sign out and switch accounts. */
function ForbiddenView({ reason }: { reason: ForbiddenReason }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <p className="text-sm font-semibold tracking-wide">Eido</p>
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col gap-5">
          <header className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              403
            </p>
            <h1 className="text-xl font-semibold tracking-tight">
              You don&apos;t have access
            </h1>
          </header>
          <Alert variant="destructive">
            <AlertDescription>{MESSAGES[reason]}</AlertDescription>
          </Alert>
          {/* A plain link: sign-out must be a full navigation, never a prefetch. */}
          <Button
            variant="outline"
            size="lg"
            className="h-12 rounded-xl"
            nativeButton={false}
            render={<a href="/auth/logout" />}
          >
            <LogOut aria-hidden />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export { ForbiddenView }
