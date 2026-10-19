// @vitest-environment happy-dom
import { act } from "react"
import { afterEach, expect, test } from "vitest"
import { cleanup, mount, stubMatchMedia } from "../test-utils"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./sidebar"

afterEach(cleanup)

function Probe() {
  const { open, state } = useSidebar()
  return <output>{`${state}:${open}`}</output>
}

function Shell({
  collapsible = "offcanvas",
}: {
  collapsible?: "offcanvas" | "none"
}) {
  return (
    <SidebarProvider>
      <Sidebar collapsible={collapsible}>
        <SidebarHeader>Head</SidebarHeader>
        <SidebarInput placeholder="Find" />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Group</SidebarGroupLabel>
            <SidebarGroupAction>+</SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive
                    tooltip="Today"
                    render={<a href="/" />}
                  >
                    Today
                  </SidebarMenuButton>
                  <SidebarMenuAction>…</SidebarMenuAction>
                  <SidebarMenuBadge>3</SidebarMenuBadge>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton render={<a href="/x" />} isActive>
                        Sub
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </SidebarMenuItem>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarSeparator />
        <SidebarFooter>Foot</SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
        <Probe />
      </SidebarInset>
    </SidebarProvider>
  )
}

test("renders the desktop sidebar, marks the active item and toggles with the trigger and shortcut", () => {
  stubMatchMedia(false)
  mount(<Shell />)
  expect(
    document.querySelector("[data-slot=sidebar-menu-button][data-active]")
      ?.textContent
  ).toBe("Today")
  expect(document.querySelector("output")?.textContent).toBe("expanded:true")
  act(() => {
    document.querySelector<HTMLElement>("[data-slot=sidebar-trigger]")!.click()
  })
  expect(document.querySelector("output")?.textContent).toBe("collapsed:false")
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        ctrlKey: true,
        cancelable: true,
      })
    )
  })
  expect(document.querySelector("output")?.textContent).toBe("expanded:true")
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }))
  })
  expect(document.querySelector("output")?.textContent).toBe("expanded:true")
})

test("collapsible none renders a static sidebar", () => {
  stubMatchMedia(false)
  mount(<Shell collapsible="none" />)
  expect(document.querySelector("[data-slot=sidebar]")?.textContent).toContain(
    "Head"
  )
})

test("on a phone the sidebar opens as a sheet from the trigger", () => {
  stubMatchMedia(true)
  mount(<Shell />)
  expect(document.body.textContent).not.toContain("Head")
  act(() => {
    document.querySelector<HTMLElement>("[data-slot=sidebar-trigger]")!.click()
  })
  expect(document.body.textContent).toContain("Head")
})

test("useSidebar throws outside a provider", () => {
  const original = console.error
  console.error = () => {}
  try {
    expect(() => mount(<Probe />)).toThrow()
  } finally {
    console.error = original
  }
})
