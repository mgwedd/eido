/** SQL predicate for current searchable documents; callers alias documents as `d`. */
export const LIVE_DOCUMENT_PREDICATE = `(d.source <> 'drive' OR EXISTS (
  SELECT 1 FROM document_heads h
  WHERE h.source = d.source AND h.source_ref = d.source_ref AND h.sha256 = d.sha256
))`
