import { describe, expect, it } from "vitest"

import UnlockPage from "@/app/unlock/page"

async function nextFor(next: string | string[] | undefined) {
  const element = await UnlockPage({ searchParams: Promise.resolve({ next }) })
  return (element.props as { next: string }).next
}

describe("unlock page", () => {
  it("passes a same-origin path on", async () => {
    expect(await nextFor("/queue")).toBe("/queue")
  })

  it("falls back to Today for an off-site address", async () => {
    expect(await nextFor("https://evil.example.invalid/")).toBe("/")
  })

  it("falls back to Today when next is repeated or missing", async () => {
    expect(await nextFor(["/a", "/b"])).toBe("/")
    expect(await nextFor(undefined)).toBe("/")
  })
})
