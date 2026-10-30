import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, expect, test, vi } from "vitest"
import { SidebarProvider } from "@eido/ui/components/sidebar"
import { AppSidebar } from "../components/app-sidebar"
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
