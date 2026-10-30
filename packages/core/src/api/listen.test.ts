import { request as httpRequest } from "node:http"
import { afterEach, describe, expect, test } from "vitest"
import { openIndex } from "../index/schema"
import { createProfileStore } from "../profile/index"
import {
  basePath,
  hostHeader,
  listenCoreApi,
  loopbackHost,
  withListenHost,
} from "./listen"
import type { CoreApi } from "./listen"

const open: CoreApi[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((api) => api.close()))
})

async function listen(
  overrides: Partial<Parameters<typeof listenCoreApi>[0]> = {}
): Promise<CoreApi> {
  const api = await listenCoreApi({
    profile: createProfileStore(openIndex(":memory:"), {
      audit: () => Promise.resolve(),
    }),
    host: "127.0.0.1",
    port: 0,
    basePath: "",
    allowedHosts: [],
    ...overrides,
  })
  open.push(api)
  return api
}

/** GET `path` on the listener with the given Host header; resolves the status. */
function get(api: CoreApi, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: api.host, port: api.port, path, headers: { host } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on("error", reject)
    req.end()
  })
}

describe("loopbackHost", () => {
  test.each(["127.0.0.1", "::1"])("accepts %s", (host) => {
    expect(loopbackHost(host)).toBe(host)
  })

  test.each([
    "0.0.0.0",
    "::",
    "192.168.1.20",
    "100.64.0.1",
    "127.0.0.2",
    "localhost",
    "",
  ])("refuses %j", (host) => {
    expect(() => loopbackHost(host)).toThrow(
      "core's API binds to 127.0.0.1 or ::1 only"
    )
  })
})

describe("basePath", () => {
  test.each(["", "/api/core", "/core", "/.well", "/api/..core"])(
    "accepts %j",
    (path) => {
      expect(basePath(path)).toBe(path)
    }
  )

  test.each([
    "/",
    "api/core",
    "/api/core/",
    "/api//core",
    "/api core",
    "/.",
    "/..",
    "/api/../core",
    "/api/.",
  ])("refuses %j", (path) => {
    expect(() => basePath(path)).toThrow("the base path must look like")
  })
})

describe("hostHeader", () => {
  test("brackets the IPv6 loopback", () => {
    expect(hostHeader("::1", 8789)).toBe("[::1]:8789")
    expect(hostHeader("127.0.0.1", 8789)).toBe("127.0.0.1:8789")
  })
})

describe("listenCoreApi", () => {
  test("answers the listen address and the configured hosts, and 421 for any other", async () => {
    const api = await listen({
      allowedHosts: ["eido.example.invalid", "127.0.0.1:1"],
    })
    expect(api.port).toBeGreaterThan(0)
    expect(api.allowedHosts).toEqual([
      `127.0.0.1:${String(api.port)}`,
      "eido.example.invalid",
      "127.0.0.1:1",
    ])
    expect(await get(api, "/profile", `127.0.0.1:${String(api.port)}`)).toBe(
      200
    )
    expect(await get(api, "/profile", "eido.example.invalid")).toBe(200)
    expect(await get(api, "/profile", "rebound.example.invalid")).toBe(421)
    expect(await get(api, "/profile", "localhost")).toBe(421)
  })

  test("listens on the IPv6 loopback", async () => {
    const api = await listen({ host: "::1" })
    expect(await get(api, "/profile", `[::1]:${String(api.port)}`)).toBe(200)
  })

  test("serves under the base path only", async () => {
    const api = await listen({ basePath: "/api/core" })
    const host = `127.0.0.1:${String(api.port)}`
    expect(await get(api, "/api/core/profile", host)).toBe(200)
    expect(await get(api, "/profile", host)).toBe(404)
  })

  test("rejects when the port is taken", async () => {
    const first = await listen()
    await expect(listen({ port: first.port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    })
  })

  test("close stops taking connections", async () => {
    const api = await listen()
    await api.close()
    open.splice(open.indexOf(api), 1)
    await expect(
      get(api, "/profile", `127.0.0.1:${String(api.port)}`)
    ).rejects.toMatchObject({ code: "ECONNREFUSED" })
  })
})

test("withListenHost does not list the listen address twice", () => {
  expect(
    withListenHost("127.0.0.1:8789", ["127.0.0.1:8789", "eido.example.invalid"])
  ).toEqual(["127.0.0.1:8789", "eido.example.invalid"])
})
