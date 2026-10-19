import { createServer } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import type { ApiHandler } from "./handler"
import { MAX_BODY_BYTES } from "./handler"

/** Reads at most MAX_BODY_BYTES + 1 bytes, so an oversized body is detectable without buffering it all. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Node adapter for the handler. The caller picks the address and calls `listen`: core has no
 * credentials and no auth of its own, so it must listen on loopback or a private interface only.
 */
export function createApiServer(handler: ApiHandler): Server {
  return createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET"
      const hasBody = method !== "GET" && method !== "HEAD"
      const body = hasBody ? await readBody(req) : undefined
      let response: Response
      if (body === null) {
        response = new Response(
          JSON.stringify({
            error: {
              code: "payload_too_large",
              message: "request body too large",
            },
          }),
          { status: 413, headers: { "content-type": "application/json" } }
        )
      } else {
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (value !== undefined) headers.set(name, [value].flat().join(", "))
        }
        const url = new URL(
          req.url ?? "/",
          `http://${req.headers.host ?? "localhost"}`
        )
        response = await handler(
          new Request(url, {
            method,
            headers,
            ...(body ? { body: new Uint8Array(body) } : {}),
          })
        )
      }
      res.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries())
      )
      res.end(Buffer.from(await response.arrayBuffer()))
    })().catch(() => {
      if (!res.headersSent)
        res.writeHead(500, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: { code: "internal", message: "internal error" },
        })
      )
    })
  })
}
