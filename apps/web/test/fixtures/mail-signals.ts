// Synthetic fixtures for the phishing-signal chip. Imported by tests only; never by app code.
import type { AskCitation, CoreApiMailSignals } from "@eido/schemas"

export const FLAGGED_SHA = "a".repeat(64)
export const CLEAN_SHA = "b".repeat(64)
export const FILE_SHA = "c".repeat(64)

/** Four signals in core's order, as GET /mail/:sha256/signals returns them. */
export const flaggedSignals = [
  { kind: "dmarc_fail" },
  { kind: "reply_to_domain", detail: "pay-desk.example.invalid" },
  {
    kind: "lookalike_domain",
    detail: "roofimg.example.invalid ~ roofing.example.invalid",
  },
  {
    kind: "link_mismatch",
    detail: "roofing.example.invalid -> pay-desk.example.invalid",
  },
] as const satisfies CoreApiMailSignals["signals"]

/** A detail carrying markup, as hostile message text would. */
export const markupSignals = [
  {
    kind: "display_name_address",
    detail:
      '<a href="https://evil.example.invalid">billing@bank.example.invalid</a>',
  },
] as const satisfies CoreApiMailSignals["signals"]

const citation: Pick<
  AskCitation,
  "source" | "injectionSuspected" | "injectionReasons"
> = {
  source: "gmail",
  injectionSuspected: false,
  injectionReasons: [],
}

export const flaggedMailCitation: AskCitation = {
  ...citation,
  tag: "M1",
  documentId: FLAGGED_SHA,
  sourceRef: "gm-roofing-invoice",
  title: "Re: roofing invoice",
}

export const cleanMailCitation: AskCitation = {
  ...citation,
  tag: "M2",
  documentId: CLEAN_SHA,
  sourceRef: "gm-roofing-quote",
  title: "Re: roofing quote",
}

export const fileCitation: AskCitation = {
  ...citation,
  tag: "F1",
  source: "drive",
  documentId: FILE_SHA,
  sourceRef: "drive-quote",
  title: "Roofing quote.pdf",
}
