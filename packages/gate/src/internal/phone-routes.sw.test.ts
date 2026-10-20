import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { PHONE_ROUTES } from "./phone-routes"

// Every phone route must be one the PWA's service worker never caches. The worker's routing
// rules are a classic script, so it is read as text and evaluated, as apps/web's own test does;
// nothing is imported across packages.

const source = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "apps",
    "web",
    "public",
    "sw-routing.js"
  ),
  "utf8"
)
const exported: unknown = runInNewContext(
  `${source}\n({ classifyRequest, SENSITIVE_SEGMENTS })`,
  { URL }
)

type Classify = (request: {
  method: string
  url: string
  origin: string
  mode: string
  hasAuthorization: boolean
}) => string

// The worker's own test pins classifyRequest's signature; here it is only called.
function isClassify(value: unknown): value is Classify {
  return typeof value === "function"
}

function worker(): { classify: Classify; sensitive: readonly string[] } {
  if (
    typeof exported !== "object" ||
    exported === null ||
    !("classifyRequest" in exported) ||
    !("SENSITIVE_SEGMENTS" in exported) ||
    !isClassify(exported.classifyRequest) ||
    !Array.isArray(exported.SENSITIVE_SEGMENTS)
  ) {
    throw new Error(
      "sw-routing.js no longer defines classifyRequest and SENSITIVE_SEGMENTS"
    )
  }
  const classifyRequest = exported.classifyRequest
  const segments: unknown[] = exported.SENSITIVE_SEGMENTS
  return {
    classify: classifyRequest,
    sensitive: segments.map(String),
  }
}

const ORIGIN = "https://eido.example.invalid"

// The browser reaches the gate at /api/gate (#178), whatever base path the listener sees.
function get(path: string) {
  return {
    method: "GET",
    url: `${ORIGIN}/api/gate${path.replace(":id", "intent-1")}`,
    origin: ORIGIN,
    mode: "cors",
    hasAuthorization: false,
  }
}

describe("the phone routes and the service worker", () => {
  const { classify, sensitive } = worker()

  it.each(PHONE_ROUTES.map((route) => [route.method, route.path]))(
    "never caches %s %s, which has a sensitive segment",
    (_method, path) => {
      expect(
        path.split("/").some((segment) => sensitive.includes(segment))
      ).toBe(true)
      // Classified as a GET, the one method the worker would otherwise cache.
      expect(classify(get(path))).toBe("network-only")
    }
  )

  it("would cache a gate read without a sensitive segment, so the check above can fail", () => {
    expect(classify(get("/activity"))).toBe("api-read")
  })
})
