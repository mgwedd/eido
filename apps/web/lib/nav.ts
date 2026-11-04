import {
  FileText,
  History,
  Inbox,
  List,
  MessageSquare,
  Plug,
  Settings,
  UserRound,
  Sun,
  type LucideIcon,
} from "lucide-react"

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /** Shown in the phone tab bar. Entries without it appear only in the desktop sidebar. */
  phone: boolean
  /** Carries the live pending count next to its label. */
  badge?: "queue"
  /** Shown in phone header overflow links. False excludes it from phone header more links. */
  phoneHeader?: boolean
  /** The keyboard shortcut from the design: "g t" is a go-to sequence, "/" a single key. */
  shortcut?: string
}

/**
 * Ordered navigation. An entry is added by the PR that ships its page, so there is
 * never a nav item without a working route (nav.test.ts checks every href).
 * Today's page is #34, Queue #33, Ask #35, Ledger #55, Activity #36, Documents #55, Profile #81.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Today", icon: Sun, phone: true, shortcut: "g t" },
  {
    href: "/queue",
    label: "Queue",
    icon: Inbox,
    phone: true,
    badge: "queue",
    shortcut: "g q",
  },
  {
    href: "/ask",
    label: "Ask",
    icon: MessageSquare,
    phone: true,
    shortcut: "/",
  },
  {
    href: "/ledger",
    label: "Ledger",
    icon: List,
    phone: true,
    shortcut: "g l",
  },
  {
    href: "/activity",
    label: "Activity",
    icon: History,
    phone: true,
    shortcut: "g a",
  },
  {
    href: "/documents",
    label: "Documents",
    icon: FileText,
    phone: false,
    phoneHeader: false,
    shortcut: "g d",
  },
  { href: "/connectors", label: "Connectors", icon: Plug, phone: false },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    phone: false,
    shortcut: "g s",
  },
  {
    href: "/profile",
    label: "Profile",
    icon: UserRound,
    phone: false,
    shortcut: "g p",
  },
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

/** The entries left out of the phone tab bar; Today links to them on phones. */
export function phoneOverflowItems(
  items: readonly NavItem[] = NAV_ITEMS
): NavItem[] {
  return items.filter((item) => !item.phone && item.phoneHeader !== false)
}
