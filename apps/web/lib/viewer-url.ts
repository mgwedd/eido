import type { SourceSpan } from "@eido/schemas"

export type ViewerSpan =
  | SourceSpan
  | {
      start?: number
      end?: number
      page?: number
      line?: number
    }

/**
 * Builds the URL to view a document in the document viewer, with optional
 * character or page/line span highlights and a `from` return destination.
 */
export function buildViewerUrl(
  documentId: string,
  span?: ViewerSpan | null,
  from?: string
): string {
  const params = new URLSearchParams()
  if (span) {
    if (typeof span.start === "number") params.set("start", String(span.start))
    if (typeof span.end === "number") params.set("end", String(span.end))
    if (typeof span.page === "number") params.set("page", String(span.page))
    if (typeof span.line === "number") params.set("line", String(span.line))
  }
  if (from) {
    params.set("from", from)
  }
  const query = params.toString()
  return query
    ? `/documents/${documentId}?${query}`
    : `/documents/${documentId}`
}
