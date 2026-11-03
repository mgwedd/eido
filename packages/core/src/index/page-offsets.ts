export type PageText = { page: number; text: string }
export type PageOffsets = { page: number; start: number; end: number }

/**
 * Where each page's text sits in `body`, as `[start, end)`. Pages are located in order, so a page
 * repeated word for word still resolves to its own place. A page that is empty, or whose text is
 * not found in the body after the previous page, gets no range: it is never guessed.
 */
export function pageOffsetsInBody(
  body: string,
  pages: readonly PageText[]
): Map<number, PageOffsets> {
  const ranges = new Map<number, PageOffsets>()
  let cursor = 0
  for (const { page, text } of pages) {
    if (text === "") continue
    const start = body.indexOf(text, cursor)
    if (start === -1) continue
    const end = start + text.length
    ranges.set(page, { page, start, end })
    cursor = end
  }
  return ranges
}
