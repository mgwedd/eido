import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, expect, test, vi } from "vitest"
import { SidebarProvider } from "@eido/ui/components/sidebar"
import { AppSidebar } from "../components/app-sidebar"
import { PhoneMoreLinks } from "../components/phone-more-links"
import { PhoneTabBar } from "../components/phone-tab-bar"

const navigation = vi.hoisted(() => ({ pathname: "/" }))
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }))

beforeEach(() => {
  navigation.pathname = "/"
})

test("sidebar lists the nav items and marks the current page", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  )
  expect(html).toContain("Eido")
  expect(html).toContain('aria-label="Primary"')
  expect(html).toContain("Today")
  expect(html).toContain('aria-current="page"')
})

test("sidebar signs out with a full navigation", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  )
  expect(html).toContain('href="/auth/logout"')
  expect(html).toContain("Sign out")
})

test("sidebar marks nothing current on an unlisted page", () => {
  navigation.pathname = "/elsewhere"
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  )
  expect(html).toContain("Today")
  expect(html).not.toContain("aria-current")
})

test("phone tab bar lists the phone items and marks the current page", () => {
  const html = renderToStaticMarkup(<PhoneTabBar />)
  expect(html).toContain("Today")
  expect(html).toContain('aria-current="page"')
})

test("phone tab bar marks nothing current on an unlisted page", () => {
  navigation.pathname = "/elsewhere"
  const html = renderToStaticMarkup(<PhoneTabBar />)
  expect(html).not.toContain("aria-current")
})

test("phone header links open Connectors, Settings and Profile with 44px targets", () => {
  const html = renderToStaticMarkup(<PhoneMoreLinks />)
  expect(html).toMatch(/^<nav aria-label="More" class="[^"]*\bmd:hidden\b/)
  const links = [...html.matchAll(/<a ([^>]*)>/g)].map(([, attrs = ""]) => ({
    href: /href="([^"]*)"/.exec(attrs)?.[1],
    label: /aria-label="([^"]*)"/.exec(attrs)?.[1],
    big: /class="[^"]*\bsize-11\b/.test(attrs),
  }))
  expect(links).toEqual([
    { href: "/connectors", label: "Connectors", big: true },
    { href: "/settings", label: "Settings", big: true },
    { href: "/profile", label: "Profile", big: true },
  ])
})
