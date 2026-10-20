import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

import { isActive, MAX_PHONE_TABS, NAV_ITEMS, phoneItems } from "./nav"

const APP_DIR = path.join(__dirname, "..", "app")

/** Routes that have an app/**\/page.tsx, with route groups like (shell) removed. */
function pageRoutes(dir = APP_DIR, prefix = ""): string[] {
  const routes: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")")
      routes.push(
        ...pageRoutes(
          path.join(dir, entry.name),
          isGroup ? prefix : `${prefix}/${entry.name}`
        )
      )
    } else if (entry.name === "page.tsx") {
      routes.push(prefix === "" ? "/" : prefix)
    }
  }
  return routes
}

describe("nav registry", () => {
  test("every href has a matching app page", () => {
    const routes = pageRoutes()
    for (const item of NAV_ITEMS) {
      expect(routes, item.href).toContain(item.href)
    }
  })

  test("hrefs are unique, absolute and labelled", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true)
      expect(item.label.length).toBeGreaterThan(0)
    }
  })

  test("Today comes first and the phone bar holds at most 5 entries", () => {
    expect(NAV_ITEMS[0]?.href).toBe("/")
    expect(phoneItems().length).toBeLessThanOrEqual(MAX_PHONE_TABS)
  })

  test("phoneItems keeps order and drops desktop-only entries", () => {
    const icon = NAV_ITEMS[0]!.icon
    const items = [
      { href: "/", label: "Today", icon, phone: true },
      { href: "/settings", label: "Settings", icon, phone: false },
      { href: "/queue", label: "Queue", icon, phone: true },
    ]
    expect(phoneItems(items).map((item) => item.href)).toEqual(["/", "/queue"])
  })

  test("the page test sees the shell route group", () => {
    expect(existsSync(APP_DIR)).toBe(true)
    expect(pageRoutes()).toContain("/")
  })
})

describe("isActive", () => {
  test("Today matches only the root", () => {
    expect(isActive("/", "/")).toBe(true)
    expect(isActive("/queue", "/")).toBe(false)
  })

  test("other entries match themselves and nested paths only", () => {
    expect(isActive("/queue", "/queue")).toBe(true)
    expect(isActive("/queue/abc", "/queue")).toBe(true)
    expect(isActive("/queued", "/queue")).toBe(false)
    expect(isActive("/", "/queue")).toBe(false)
  })
})
