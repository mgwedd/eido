import { describe, expect, it } from "vitest"

import { securityHeaders } from "@/lib/security-headers"
import nextConfig from "../next.config"

const header = (key: string) =>
  securityHeaders().find((h) => h.key === key)?.value

describe("securityHeaders", () => {
  it.each([
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["X-Frame-Options", "DENY"],
    ["Strict-Transport-Security", "max-age=31536000"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
    [
      "Content-Security-Policy",
      "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    ],
  ])("sends %s", (key, value) => {
    expect(header(key)).toBe(value)
  })

  it("leaves WebAuthn alone and sets no script, style, default or connect CSP", () => {
    expect(header("Permissions-Policy")).not.toContain("publickey-credentials")
    expect(header("Content-Security-Policy")).not.toMatch(
      /script-src|style-src|default-src|connect-src/
    )
  })
})

describe("next.config headers", () => {
  it("applies the security headers to every path, static assets included", async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const all = rules.find((rule) => rule.source === "/:path*")
    expect(all?.headers).toEqual(securityHeaders())
  })
})
