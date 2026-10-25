import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { DriveFile, DriveTransport } from "./client"

export type FakeFile = DriveFile & { text?: string; bytes?: Uint8Array }
export async function fakeDrive() {
  const files = new Map<string, FakeFile>()
  const changes = new Map<
    string,
    {
      files?: DriveFile[]
      removed?: string[]
      nextPageToken?: string
      newStartPageToken?: string
    }
  >()
  const requests: { path: string; query: URLSearchParams; method: string }[] =
    []
  const failures = new Set<string>()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    requests.push({
      path: url.pathname,
      query: url.searchParams,
      method: request.method ?? "",
    })
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    if (request.method !== "GET") {
      json({}, 405)
      return
    }
    if (
      failures.delete(
        `${url.pathname}?${url.searchParams.get("pageToken") ?? ""}`
      )
    ) {
      json({}, 500)
      return
    }
    if (url.pathname === "/drive/v3/changes/startPageToken") {
      json({ startPageToken: "start" })
      return
    }
    if (url.pathname === "/drive/v3/files") {
      const index = Number(url.searchParams.get("pageToken") ?? 0)
      const file = [...files.values()][index]
      json({
        files: file === undefined ? [] : [file],
        ...(index + 1 < files.size ? { nextPageToken: String(index + 1) } : {}),
      })
      return
    }
    if (url.pathname === "/drive/v3/changes") {
      const page = changes.get(url.searchParams.get("pageToken") ?? "") ?? {
        newStartPageToken: "end",
      }
      json({
        changes: [
          ...(page.files ?? []).map((file) => ({
            fileId: file.id,
            removed: false,
            file,
          })),
          ...(page.removed ?? []).map((fileId) => ({ fileId, removed: true })),
        ],
        ...(page.nextPageToken === undefined
          ? {}
          : { nextPageToken: page.nextPageToken }),
        ...(page.newStartPageToken === undefined
          ? {}
          : { newStartPageToken: page.newStartPageToken }),
      })
      return
    }
    const match = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname)
    const file =
      match?.[1] === undefined
        ? undefined
        : files.get(decodeURIComponent(match[1]))
    if (file === undefined) {
      json({}, 404)
      return
    }
    if (match?.[2] !== undefined || url.searchParams.get("alt") === "media") {
      response.writeHead(200)
      response.end(file.bytes ?? file.text ?? "")
      return
    }
    json(file)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("missing fake server address")
  const port = (address satisfies AddressInfo).port
  const transport: DriveTransport = (request) => {
    const url = new URL(request.url)
    url.protocol = "http:"
    url.hostname = "127.0.0.1"
    url.port = String(port)
    return fetch(url, { method: request.method })
  }
  return {
    files,
    changes,
    requests,
    failures,
    transport,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error)
        )
      ),
  }
}
