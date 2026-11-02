import { describe, expect, it } from "vitest"

import UnlockPage from "@/app/unlock/page"

async function nextFor(next: string | string[] | undefined) {
  const element = await UnlockPage({ searchParams: Promise.resolve({ next }) })
  return (element.props as { next: string }).next
}

describe("unlock page", () => {
  it("marks the page expired only for expired=1", async () => {
    const flag = async (expired: string | undefined) =>
      (
        (await UnlockPage({ searchParams: Promise.resolve({ expired }) }))
          .props as { expired: boolean }
      ).expired
    expect(await flag("1")).toBe(true)
    expect(await flag("0")).toBe(false)
    expect(await flag(undefined)).toBe(false)
  })

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
