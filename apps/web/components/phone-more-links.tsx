import Link from "next/link"

import { buttonVariants } from "@eido/ui/components/button"
import { cn } from "@eido/ui/lib/utils"
import { phoneOverflowItems } from "@/lib/nav"

/** Phone-only icon links (44px) to the pages the tab bar leaves out. */
export function PhoneMoreLinks() {
  return (
    <nav aria-label="More" className="flex gap-2 md:hidden">
      {phoneOverflowItems().map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-label={label}
          className={cn(
            buttonVariants({ variant: "outline", size: "icon" }),
            "size-11 rounded-full"
          )}
        >
          <Icon aria-hidden className="size-5" />
        </Link>
      ))}
    </nav>
  )
}
