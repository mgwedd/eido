export const INJECTION_REASONS = [
  "fence-tag",
  "template-marker",
  "boundary-confusion",
  "hidden-characters",
] as const

export type InjectionReason = (typeof INJECTION_REASONS)[number]

export const INJECTION_REASON_LABELS: Readonly<
  Record<InjectionReason, string>
> = {
  "fence-tag": "Forged fence tag",
  "template-marker": "Template marker",
  "boundary-confusion": "Boundary-confusion line",
  "hidden-characters": "Hidden characters",
}

export const INJECTION_PANEL_TITLE = "Possible injection"
export const INJECTION_PANEL_DESCRIPTION =
  "This item contained text that tried to pass as instructions."
export const INJECTION_CHIP_LABEL = "Possible injection"
export const INJECTION_BUTTON_LABEL = "!"

export function normalizeInjectionReasons(
  reasons?: readonly string[] | null
): InjectionReason[] {
  if (!reasons || reasons.length === 0) return []
  const set = new Set(reasons)
  return INJECTION_REASONS.filter((r) => set.has(r))
}

export function isInjectionSuspected(
  input?: {
    injectionSuspected?: boolean
    reasons?: readonly string[]
    injection?: { reasons?: readonly string[] } | null
  } | null
): boolean {
  if (!input) return false
  if (input.injectionSuspected) return true
  if (
    input.injection &&
    Array.isArray(input.injection.reasons) &&
    input.injection.reasons.length > 0
  ) {
    return true
  }
  if (Array.isArray(input.reasons) && input.reasons.length > 0) {
    return true
  }
  return false
}
