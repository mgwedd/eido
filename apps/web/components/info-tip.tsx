"use client"

import { Info } from "lucide-react"
import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@eido/ui/components/tooltip"

/** A 44px info button whose tooltip holds the how-it-works text; tap toggles it on touch. */
function InfoTip({ label, children }: { label: string; children: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className="-my-2 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Info aria-hidden className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  )
}

export { InfoTip }
