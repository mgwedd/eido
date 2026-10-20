import { Sun, type LucideIcon } from "lucide-react"

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /** Shown in the phone tab bar. Entries without it appear only in the desktop sidebar. */
  phone: boolean
}

/**
 * Ordered navigation. An entry is added by the PR that ships its page, so there is
 * never a nav item without a working route (nav.test.ts checks every href).
 * Today's page is #34, Queue #33, Ask #35, Activity #36.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Today", icon: Sun, phone: true },
]

export const MAX_PHONE_TABS = 5

/** The current path matches the entry exactly, or is nested under it (never for "/"). */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function phoneItems(items: readonly NavItem[] = NAV_ITEMS): NavItem[] {
  return items.filter((item) => item.phone)
}
