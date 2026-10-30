export { DEFAULT_DB_PATH, SCHEMA_VERSION, openIndex } from "./schema"
export { getCursor, ingestBatch } from "./ingest"
export type {
  Cursor,
  DocumentHeadChange,
  IndexedDocument,
  IngestResult,
  MailAddressRole,
} from "./ingest"
export { countMatches, search } from "./search"
export type { SearchHit, SearchQuery } from "./search"
