import type { CoreApiEntity, CoreApiProfileResponse } from "@eido/schemas"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, expect, test } from "vitest"
import { request as httpRequest } from "node:http"
import type { Server } from "node:http"
import { openIndex } from "../index/schema"
import { createProfileStore } from "../profile/index"
import { createApiHandler } from "./handler"
import { MAX_BODY_BYTES } from "./handler"
import { createApiServer } from "./server"

let server: Server
let base: string

beforeEach(async () => {
  const profile = createProfileStore(openIndex(":memory:"), {
    audit: () => Promise.resolve(),
  })
  // The allowed host carries the port, which is known only after listen.
  let handler = createApiHandler({ profile, allowedHosts: [] })
  server = createApiServer((request) => handler(request))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  handler = createApiHandler({ profile, allowedHosts: [host] })
  base = `http://${host}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("a write over real HTTP reaches the store and the next read sees it", async () => {
  const put = await fetch(`${base}/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Test Owner",
      timezone: "Europe/Zurich",
    }),
  })
  expect(put.status).toBe(200)
  expect(put.headers.get("content-type")).toBe("application/json")
  const got = await fetch(`${base}/profile`)
  const body = (await got.json()) as CoreApiProfileResponse
  expect(body.profile?.displayName).toBe("Test Owner")
})

test("an error status and the Allow header survive the adapter", async () => {
  const res = await fetch(`${base}/profile`, { method: "DELETE" })
  expect(res.status).toBe(405)
  expect(res.headers.get("allow")).toBe("GET, PATCH")
})

test("a 204 has no body", async () => {
  const created = (await (
    await fetch(`${base}/entities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "personal", name: "N", tag: "n" }),
    })
  ).json()) as CoreApiEntity
  const res = await fetch(`${base}/entities/${created.id}`, {
    method: "DELETE",
  })
  expect([res.status, await res.text()]).toEqual([204, ""])
})

test("a body over the limit is 413 and the server keeps serving", async () => {
  const big = await fetch(`${base}/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signature: "x".repeat(MAX_BODY_BYTES) }),
  })
  expect(big.status).toBe(413)
  expect((await fetch(`${base}/profile`)).status).toBe(200)
})

test("a foreign Host header is refused at the socket", async () => {
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      `${base}/profile`,
      { headers: { host: "rebound.example.invalid" } },
      (res) => {
        res.resume()
        resolve(res.statusCode)
      }
    )
    req.on("error", reject)
    req.end()
  })
  expect(status).toBe(421)
})

test("a handler that throws becomes a 500 with no cause", async () => {
  const failing = createApiServer(() =>
    Promise.reject(new Error("cause with owner@example.test"))
  )
  await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve))
  const port = (failing.address() as AddressInfo).port
  const res = await fetch(`http://127.0.0.1:${port}/profile`)
  const text = await res.text()
  await new Promise<void>((resolve) => failing.close(() => resolve()))
  expect(res.status).toBe(500)
  expect(text).not.toContain("owner@example.test")
})
