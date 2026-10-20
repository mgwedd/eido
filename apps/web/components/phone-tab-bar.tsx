"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@eido/ui/lib/utils"
import { isActive, phoneItems } from "@/lib/nav"

function PhoneTabBar() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid auto-cols-fr grid-flow-col">
        {phoneItems().map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href)
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-[52px] flex-col items-center justify-center gap-1 outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/50 focus-visible:ring-inset",
                  active ? "text-foreground" : "text-muted-foreground"
                )}
              >
                <Icon aria-hidden className="size-5" />
                <span className="text-[11px] leading-none">{label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export { PhoneTabBar }
