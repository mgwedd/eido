// Word matching shared by the Todos and Events blocks of a proposal pack: a request and an item
// title match on the words they share, lowercase, with stop words removed.

/** Articles, prepositions and request filler that carry no match in any block. */
const COMMON_STOP_WORDS =
  "a an and are as at be but by for from has have i if in into is it its me my of on or our so " +
  "that the their then there these this those to up us was we were what when which who will with " +
  "you your please can could would should do does did not no yes all any some"

/** The common stop words plus `extra`, the words every request about one kind of item holds. */
export function stopWords(extra: string): ReadonlySet<string> {
  return new Set(`${COMMON_STOP_WORDS} ${extra}`.split(" "))
}

/** The distinct lowercase words of `text`, letters and digits only, without `stop`. */
export function matchWords(
  text: string,
  stop: ReadonlySet<string>
): Set<string> {
  const found = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(found.filter((w) => !stop.has(w)))
}
