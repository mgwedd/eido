// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import ForbiddenPage from "@/app/forbidden/page"
import { ForbiddenView } from "@/components/forbidden-view"
import { register } from "@/instrumentation"
import { AllowListError } from "@/lib/auth/roles"
import { describeStates } from "./render-states"

const sdk = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
}))
vi.mock("@/lib/auth0", () => ({
  auth0: { getSession: () => Promise.resolve(sdk.session) },
}))
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))

describeStates("Forbidden states", [
  {
    state: "email not verified",
    render: () => <ForbiddenView reason="unverified" />,
    role: "alert",
    message:
      "This account's email address isn't verified. Sign in with a verified address.",
  },
  {
    state: "not on the allow-list",
    render: () => <ForbiddenView reason="not-invited" />,
    role: "alert",
    message: "This account isn't on Eido's allow-list.",
  },
  {
    state: "assistant on an owner-only page",
    render: () => <ForbiddenView reason="owner-only" />,
    role: "alert",
    message: "This page is only for the person Eido works for.",
  },
])

describe("forbidden page", () => {
  beforeEach(() => {
    vi.stubEnv("EIDO_OWNER_EMAIL", "owner@example.test")
    vi.stubEnv("EIDO_ASSISTANT_EMAILS", "assistant@example.test")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    sdk.session = null
  })

  it("signs out with a full navigation, never a prefetched link", () => {
    const html = renderToStaticMarkup(<ForbiddenView reason="owner-only" />)
    expect(html).toContain('href="/auth/logout"')
    expect(html).toContain("Sign out")
  })

  it("sends a signed-out visitor to login", async () => {
    await expect(ForbiddenPage()).rejects.toThrow("redirect:/auth/login")
  })

  it("sends the owner home", async () => {
    sdk.session = {
      user: { email: "owner@example.test", email_verified: true },
    }
    await expect(ForbiddenPage()).rejects.toThrow("redirect:/")
  })

  it("tells an assistant the page is the owner's", async () => {
    sdk.session = {
      user: { email: "assistant@example.test", email_verified: true },
    }
    const element = await ForbiddenPage()
    expect((element.props as { reason: string }).reason).toBe("owner-only")
  })
})

describe("instrumentation", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("refuses to start without a valid allow-list", () => {
    vi.stubEnv("EIDO_OWNER_EMAIL", "")
    expect(() => register()).toThrow(AllowListError)
  })

  it("starts with a valid allow-list", () => {
    vi.stubEnv("EIDO_OWNER_EMAIL", "owner@example.test")
    expect(() => register()).not.toThrow()
  })
})
