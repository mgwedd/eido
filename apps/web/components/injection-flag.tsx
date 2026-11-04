"use client"

import * as React from "react"
import type { GateIntentInjection } from "@eido/schemas"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@eido/ui/components/sheet"
import { cn } from "@eido/ui/lib/utils"
import {
  INJECTION_BUTTON_LABEL,
  INJECTION_CHIP_LABEL,
  INJECTION_PANEL_DESCRIPTION,
  INJECTION_PANEL_TITLE,
  INJECTION_REASON_LABELS,
  isInjectionSuspected,
  normalizeInjectionReasons,
  type InjectionReason,
} from "@/lib/injection"

export interface InjectionFlagProps {
  injectionSuspected?: boolean
  reasons?: readonly string[]
  injection?: GateIntentInjection | { reasons?: readonly string[] } | null
  variant?: "chip" | "button"
  defaultOpen?: boolean
  className?: string
}

export function InjectionFlag({
  injectionSuspected,
  reasons: explicitReasons,
  injection,
  variant = "chip",
  defaultOpen,
  className,
}: InjectionFlagProps) {
  const rawReasons = explicitReasons ?? injection?.reasons
  const reasons: InjectionReason[] = React.useMemo(
    () => normalizeInjectionReasons(rawReasons),
    [rawReasons]
  )

  const flagged = isInjectionSuspected({
    injectionSuspected,
    reasons: explicitReasons,
    injection,
  })

  if (!flagged) {
    return <span data-slot="injection-flag" role="status" className="sr-only" />
  }

  const triggerClass =
    variant === "chip"
      ? cn(
          "inline-flex h-6 items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:border-amber-400/40 dark:text-amber-400",
          className
        )
      : cn(
          "inline-flex size-5 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 p-0 text-xs leading-none font-bold text-amber-600 transition-colors hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:border-amber-400/40 dark:text-amber-400",
          className
        )

  return (
    <span
      data-slot="injection-flag"
      role="status"
      className="inline-flex items-center"
    >
      <Sheet defaultOpen={defaultOpen}>
        <SheetTrigger
          type="button"
          className={triggerClass}
          aria-label={INJECTION_CHIP_LABEL}
        >
          {variant === "chip" ? INJECTION_CHIP_LABEL : INJECTION_BUTTON_LABEL}
        </SheetTrigger>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{INJECTION_PANEL_TITLE}</SheetTitle>
            <SheetDescription>{INJECTION_PANEL_DESCRIPTION}</SheetDescription>
          </SheetHeader>
          {reasons.length > 0 && (
            <div className="px-4">
              <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-foreground">
                {reasons.map((reason) => (
                  <li key={reason}>{INJECTION_REASON_LABELS[reason]}</li>
                ))}
              </ul>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </span>
  )
}
