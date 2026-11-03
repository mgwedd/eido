import {
  validateCoreApiDocumentList,
  type CoreApiDocumentList,
} from "@eido/schemas"

export type DocumentItem = CoreApiDocumentList["documents"][number]

export const DOCUMENTS_URL = "/api/core/documents"
export const DEFAULT_DOCUMENTS_LIMIT = 50

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  "proton-mail": "Proton Mail",
  "google-drive": "Drive",
  "local-folder": "Files",
}

export function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

/** Formats a document date (occurred or ingested) as short month and day (e.g. "Oct 12"). */
export function formatDocumentDate(isoString: string): string {
  try {
    const date = new Date(
      isoString.includes("T") ? isoString : `${isoString}T00:00:00Z`
    )
    if (Number.isNaN(date.getTime())) return isoString
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(date)
  } catch {
    return isoString
  }
}

/** Formats source with provenance distinguishing Files, Drive and Gmail attachment per design. */
export function formatDocumentSource(
  source: string,
  entityName?: string,
  mime?: string
): string {
  if (source === "local-folder" || source === "files") {
    return entityName ? `Files/${entityName}` : "Files"
  }
  if (source === "gmail") {
    return mime && mime !== "message/rfc822" ? "Gmail attachment" : "Gmail"
  }
  if (source === "proton-mail") {
    return mime && mime !== "message/rfc822"
      ? "Proton attachment"
      : "Proton Mail"
  }
  if (source === "google-drive" || source === "drive") {
    return "Drive"
  }
  return formatSourceLabel(source)
}

/** Formats an ingested date for the table or list view. */
export function formatIngestedDate(isoString: string): string {
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return isoString
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date)
  } catch {
    return isoString
  }
}

export interface LoadDocumentsOptions {
  entity?: string
  source?: string
  type?: string
  q?: string
  limit?: number
  offset?: number
}

export type DocumentLoadResult =
  | { status: "ok"; data: CoreApiDocumentList }
  | { status: "unauthenticated" }
  | { status: "error"; message: string }

/**
 * Loads documents from core over HTTP.
 */
export async function loadDocumentsList(
  signal: AbortSignal,
  options: LoadDocumentsOptions = {}
): Promise<DocumentLoadResult> {
  try {
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost"
    const url = new URL(DOCUMENTS_URL, origin)
    if (options.entity && options.entity !== "all") {
      url.searchParams.set("entity", options.entity)
    }
    if (options.source && options.source !== "all") {
      url.searchParams.set("source", options.source)
    }
    if (options.type) {
      url.searchParams.set("type", options.type)
    }
    if (options.q) {
      url.searchParams.set("q", options.q)
    }
    if (typeof options.limit === "number") {
      url.searchParams.set("limit", String(options.limit))
    }
    if (typeof options.offset === "number" && options.offset > 0) {
      url.searchParams.set("offset", String(options.offset))
    }

    const response = await fetch(url.toString(), {
      cache: "no-store",
      signal,
    })

    if (response.status === 401) {
      return { status: "unauthenticated" }
    }
    if (!response.ok) {
      return {
        status: "error",
        message: `HTTP ${response.status}`,
      }
    }

    const body: unknown = await response.json()
    const parsed = validateCoreApiDocumentList(body)
    if (!parsed.ok) {
      return {
        status: "error",
        message: `Invalid schema: ${parsed.errors.join("; ")}`,
      }
    }

    return { status: "ok", data: parsed.value }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error
    }
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Network error",
    }
  }
}
