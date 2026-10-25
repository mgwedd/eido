import { DriveError } from "./errors"
export { DriveError } from "./errors"
import { pdfText } from "./pdf"
import { asObject, optionalString } from "../gmail/json"

export type DriveTransport = (
  request: Readonly<{ method: "GET"; url: string }>
) => Promise<Response>
export type DriveFile = { id: string; name: string; mimeType: string }

function required(value: unknown, key: string): string {
  const object = asObject(value)
  const text = object === undefined ? undefined : optionalString(object, key)
  if (text === undefined) throw new DriveError("invalid_response")
  return text
}
function file(value: unknown): DriveFile {
  return {
    id: required(value, "id"),
    name: required(value, "name"),
    mimeType: required(value, "mimeType"),
  }
}
function array(value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new DriveError("invalid_response")
  return value
}
export function createDriveTransport(options: {
  proxyUrl: string
  fetch?: typeof fetch
}): DriveTransport {
  const send = options.fetch ?? fetch
  return async (request) => {
    try {
      return await send(new URL("/", options.proxyUrl), {
        method: "GET",
        headers: { "x-eido-connector": "drive", "x-eido-target": request.url },
        redirect: "manual",
      })
    } catch {
      throw new DriveError("gate_unavailable")
    }
  }
}
export function createDriveClient(transport: DriveTransport) {
  async function get(
    path: string,
    query: Record<string, string | undefined> = {}
  ) {
    const url = new URL(`https://www.googleapis.com/drive/v3/${path}`)
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, value)
    const response = await transport({ method: "GET", url: url.href })
    if (!response.ok)
      throw new DriveError(
        response.status === 410 ? "cursor_expired" : "read_failed"
      )
    return response
  }
  async function json(
    path: string,
    query: Record<string, string | undefined> = {}
  ) {
    let raw: unknown
    try {
      raw = await (await get(path, query)).json()
    } catch (error) {
      if (error instanceof DriveError) throw error
      throw new DriveError("invalid_response")
    }
    const object = asObject(raw)
    if (object === undefined) throw new DriveError("invalid_response")
    return object
  }
  async function listFiles(
    options: { query?: string; pageToken?: string } = {}
  ) {
    const body = await json("files", {
      q:
        options.query === undefined
          ? "trashed = false"
          : `trashed = false and (${options.query})`,
      pageSize: "100",
      pageToken: options.pageToken,
      fields: "nextPageToken,files(id,name,mimeType)",
    })
    return {
      files: array(body["files"]).map(file),
      nextPageToken: optionalString(body, "nextPageToken"),
    }
  }
  return {
    listFiles,
    searchFiles: (query: string) => listFiles({ query }),
    async getFileText(fileId: string) {
      const path = `files/${encodeURIComponent(fileId)}`
      const metadata = file(await json(path, { fields: "id,name,mimeType" }))
      if (metadata.id !== fileId) throw new DriveError("invalid_response")
      let text: string
      if (metadata.mimeType === "application/vnd.google-apps.document")
        text = await (
          await get(`${path}/export`, { mimeType: "text/plain" })
        ).text()
      else if (metadata.mimeType === "application/pdf")
        text = await pdfText(
          new Uint8Array(
            await (await get(path, { alt: "media" })).arrayBuffer()
          )
        )
      else if (metadata.mimeType.startsWith("text/"))
        text = await (await get(path, { alt: "media" })).text()
      else throw new DriveError("unsupported_type")
      return { ...metadata, text, untrusted: true as const }
    },
    async startPageToken() {
      return required(await json("changes/startPageToken"), "startPageToken")
    },
    async changes(pageToken: string) {
      const body = await json("changes", {
        pageToken,
        pageSize: "100",
        fields:
          "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,trashed))",
      })
      const files = array(body["changes"]).flatMap((raw) => {
        const change = asObject(raw)
        if (change === undefined) throw new DriveError("invalid_response")
        if (change["removed"] === true) return []
        const entry = asObject(change["file"])
        if (entry?.["trashed"] === true) return []
        return [file(entry)]
      })
      const nextPageToken = optionalString(body, "nextPageToken")
      const newStartPageToken = optionalString(body, "newStartPageToken")
      if (nextPageToken === undefined && newStartPageToken === undefined)
        throw new DriveError("invalid_response")
      return { files, nextPageToken, newStartPageToken }
    },
  }
}
export type DriveClient = ReturnType<typeof createDriveClient>
