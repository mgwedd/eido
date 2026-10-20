/** Lowercase, strip diacritics. Mirrors the FTS5 unicode61 tokenizer closely enough for term matching. */
export function normalize(input: string): string {
  return input.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

/** Split user input or document text into normalized alphanumeric terms. */
export function tokenize(input: string): string[] {
  return normalize(input).match(/[\p{L}\p{N}]+/gu) ?? []
}

/** True when a and b are within Damerau-Levenshtein distance 1 (optimal string alignment). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  while (i < la && i < lb && a[i] === b[i]) i++
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true // substitution
    // adjacent transposition
    return (
      a[i] === b[i + 1] &&
      a[i + 1] === b[i] &&
      a.slice(i + 2) === b.slice(i + 2)
    )
  }
  const [longer, shorter] = la > lb ? [a, b] : [b, a]
  return longer.slice(i + 1) === shorter.slice(i) // insertion or deletion
}

const SOUNDEX_CODES: Record<string, string> = {
  b: "1",
  f: "1",
  p: "1",
  v: "1",
  c: "2",
  g: "2",
  j: "2",
  k: "2",
  q: "2",
  s: "2",
  x: "2",
  z: "2",
  d: "3",
  t: "3",
  l: "4",
  m: "5",
  n: "5",
  r: "6",
}

/** American Soundex of one word; null when it has no ASCII letters. */
export function soundex(word: string): string | null {
  const letters = normalize(word).replace(/[^a-z]/g, "")
  const first = letters[0]
  if (first === undefined) return null
  let out = first.toUpperCase()
  let prev = SOUNDEX_CODES[first] ?? ""
  for (const ch of letters.slice(1)) {
    const code = SOUNDEX_CODES[ch] ?? ""
    if (code !== "" && code !== prev) out += code
    // h and w do not separate equal codes; vowels do
    if (ch !== "h" && ch !== "w") prev = code
    if (out.length === 4) break
  }
  return out.padEnd(4, "0")
}
