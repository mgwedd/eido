"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Lock, RefreshCw, ServerOff } from "lucide-react"

import { Alert, AlertAction, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button, buttonVariants } from "@eido/ui/components/button"
import { cn } from "@eido/ui/lib/utils"
import { AdminProvider, useAdmin } from "@/components/admin-step-up"
import { remaining } from "@/lib/admin/elevation"

/** The Admin tabs, in the design's order. Each is a page of its own. */
export const ADMIN_TABS = [
  { href: "/admin", label: "Status" },
  { href: "/admin/connectors", label: "Connectors" },
  { href: "/admin/model", label: "Model" },
  { href: "/admin/devices", label: "Devices" },
] as const

/** The tab for `pathname`: Status only on /admin itself, the others on their path and below. */
export function activeTab(pathname: string): string | undefined {
  return ADMIN_TABS.find((tab) =>
    tab.href === "/admin"
      ? pathname === "/admin"
      : pathname === tab.href || pathname.startsWith(`${tab.href}/`)
  )?.href
}

/** "Elevated · 4:12", counting down each second while the step-up lasts. */
function ElevatedChip() {
  const { elevatedUntil } = useAdmin()
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (elevatedUntil === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [elevatedUntil])
  if (elevatedUntil === null) return null
  return (
    <Badge variant="secondary" className="gap-1 font-mono tabular-nums">
      <Lock aria-hidden className="size-3" />
      Elevated · {remaining(elevatedUntil, now)}
    </Badge>
  )
}

/**
 * The gate is not answering at all: every Admin page shows this in place of its content. The
 * alert is the message alone, so Retry is not read as part of it.
 */
export function AdminUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert role="none">
      <ServerOff aria-hidden />
      <AlertDescription role="alert">
        Can&apos;t reach the gate on the host.
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden />
          Retry
        </Button>
      </AlertAction>
    </Alert>
  )
}

/** A page's own read failed: its message, with Retry. */
export function AdminError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <Alert role="none" variant="destructive">
      <AlertDescription role="alert">{message}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden />
          Retry
        </Button>
      </AlertAction>
    </Alert>
  )
}

function AdminHeader({ notice }: { notice: string }) {
  const pathname = usePathname()
  const active = activeTab(pathname)
  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-heading text-xl font-semibold">Admin</h1>
        <ElevatedChip />
      </div>
      <nav aria-label="Admin" className="flex gap-1 overflow-x-auto">
        {ADMIN_TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active === tab.href ? "page" : undefined}
            className={cn(
              buttonVariants({
                variant: active === tab.href ? "secondary" : "ghost",
                size: "sm",
              })
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <p role="status" className="sr-only">
        {notice}
      </p>
    </header>
  )
}

/** The frame every Admin page shares: header, tabs, the step-up chip and the one prompt. */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = React.useState("")
  React.useEffect(() => {
    if (notice === "") return
    const timer = setTimeout(() => setNotice(""), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  return (
    <AdminProvider onElevated={() => setNotice("Elevated for 5 minutes")}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <AdminHeader notice={notice} />
        {notice === "" ? null : (
          <p className="text-sm text-muted-foreground" aria-hidden>
            {notice}
          </p>
        )}
        {children}
      </div>
    </AdminProvider>
  )
}
