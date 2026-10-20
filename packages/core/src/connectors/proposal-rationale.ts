/**
 * The model's own note on why it proposes a write, passed in by the caller of a write verb.
 * It is untrusted model output: the gate stores it for the approval card and never hashes it or
 * tiers on it, and the proposal schema caps its length.
 */
export type ProposalNote = { rationale?: string }

/** The `rationale` field of a proposal: absent when the caller gave none or only whitespace. */
export function rationaleField(note: ProposalNote | undefined): {
  rationale?: string
} {
  const text = note?.rationale?.trim()
  return text === undefined || text === "" ? {} : { rationale: text }
}
