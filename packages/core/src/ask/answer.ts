// Pure post-processing of the model's answer. Every number and every citation the response
// reports is decided here, by code.

const NUMBER = new Intl.NumberFormat("en-US")

/** A count with thousands separators: 1284 -> "1,284". */
export const formatCount = (n: number): string => NUMBER.format(n)

/** `read 6 of 1,284 matching messages in full`. */
export function coverageLabel(readInFull: number, matched: number): string {
  return `read ${formatCount(readInFull)} of ${formatCount(matched)} matching messages in full`
}

/** The answer for a plan with no matches, written by code. */
export function noMatchAnswer(terms: string[], searched: number): string {
  const quoted = terms.map((t) => `"${t}"`).join(", ")
  return `No match found for ${quoted} in ${formatCount(searched)} indexed messages.`
}

/**
 * What replaces an answer that claims something never happened. The index only shows what was
 * found, so the strongest honest wording is that the messages read did not contain it.
 */
export function absenceReplacement(readInFull: number): string {
  return `No match found in the ${formatCount(readInFull)} messages read in full.`
}

export interface Facts {
  matches: number
  read: number
  searched: number
}

/** Replace `{matches}`, `{read}` and `{searched}` with the code-computed counts. */
export function substitutePlaceholders(text: string, facts: Facts): string {
  return text.replace(/\{(matches|read|searched)\}/g, (_, name: string) =>
    formatCount(
      name === "matches"
        ? facts.matches
        : name === "read"
          ? facts.read
          : facts.searched
    )
  )
}

export interface CheckedTags {
  text: string
  /** Real tags, in order of first appearance, without brackets. */
  cited: string[]
  /** Invented tags, in order of first appearance, without brackets. */
  dropped: string[]
}

/**
 * Keep the `[M<n>]` tags that name a pack member and remove the rest, together with the space
 * before them, so "done [M9]." reads "done.".
 */
export function checkTags(
  text: string,
  packTags: ReadonlySet<string>
): CheckedTags {
  const cited: string[] = []
  const dropped: string[] = []
  const kept = text.replace(/ ?\[M(\d+)\]/g, (match: string, n: string) => {
    const tag = `M${n}`
    if (packTags.has(tag)) {
      if (!cited.includes(tag)) cited.push(tag)
      return match
    }
    if (!dropped.includes(tag)) dropped.push(tag)
    return ""
  })
  return { text: kept.trim(), cited, dropped }
}

// "no match found" is allowed; these claim that something did not exist or happen.
const ABSENCE = [
  /\bnever\s+(happened|occurred|took\s+place|existed|exist|happen|occur)\b/i,
  /\b(did|does|do|has|have|had)\s*(n['’]t|\s+not)\s+(ever\s+)?(happen|happened|occur|occurred|exist|existed|take\s+place|taken\s+place)\b/i,
  /\b(has|have|had)\s+never\s+(been|happened|occurred|existed|taken\s+place)\b/i,
  /\bno\s+such\b/i,
  /\bnothing\s+(like\s+that\s+)?(ever\s+)?(happened|occurred)\b/i,
]

/** True when the text claims that something never happened, rather than that nothing matched. */
export function claimsAbsence(text: string): boolean {
  return ABSENCE.some((re) => re.test(text))
}
