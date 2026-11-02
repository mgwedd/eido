/** The phishing signals core computes for a mail message, in the fixed order they are listed. */
export const MAIL_SIGNAL_KINDS = [
  "spf_fail",
  "dkim_fail",
  "dmarc_fail",
  "display_name_address",
  "reply_to_domain",
  "punycode_domain",
  "mixed_script_domain",
  "lookalike_domain",
  "link_mismatch",
] as const

export type MailSignalKind = (typeof MAIL_SIGNAL_KINDS)[number]

/** `detail` is untrusted text from the message (a domain, an address): stored, never sent to a model. */
export interface MailSignal {
  kind: MailSignalKind
  detail: string
}
