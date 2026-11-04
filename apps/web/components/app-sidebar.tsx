"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Keyboard, LogOut } from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@eido/ui/components/sidebar"
import { QueuePill, useQueueCount } from "@/components/queue-count"
import { ShortcutKeys, useOpenLegend } from "@/components/shortcuts-provider"
import { isActive, NAV_ITEMS } from "@/lib/nav"
import { queueLinkName } from "@/lib/queue/badge"
import { keysOf } from "@/lib/shortcuts"

function BrandBlock() {
  return (
    <div className="flex items-center gap-3 px-2 py-1">
      <span
        aria-hidden
        className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
      >
        E
      </span>
      <span className="text-sm font-semibold">Eido</span>
    </div>
  )
}

function AppSidebar() {
  const pathname = usePathname()
  const queue = useQueueCount()
  const openLegend = useOpenLegend()

  return (
    <Sidebar
      collapsible="none"
      className="sticky top-0 hidden h-svh border-r border-sidebar-border md:flex"
    >
      <SidebarHeader>
        <BrandBlock />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label="Primary">
              <SidebarMenu>
                {NAV_ITEMS.map(
                  ({ href, label, icon: Icon, shortcut, badge }) => {
                    const active = isActive(pathname, href)
                    return (
                      <SidebarMenuItem key={href}>
                        <SidebarMenuButton
                          isActive={active}
                          className="min-h-10"
                          render={
                            <Link
                              href={href}
                              aria-current={active ? "page" : undefined}
                              aria-label={
                                badge === "queue"
                                  ? queueLinkName(label, queue)
                                  : undefined
                              }
                            />
                          }
                        >
                          <Icon aria-hidden />
                          <span>{label}</span>
                          {badge === "queue" && <QueuePill queue={queue} />}
                          {shortcut ? (
                            <span className={badge ? "ml-2" : "ml-auto"}>
                              <ShortcutKeys keys={keysOf(shortcut)} />
                            </span>
                          ) : null}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  }
                )}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="min-h-10" onClick={openLegend}>
              <Keyboard aria-hidden />
              <span>Keyboard shortcuts</span>
              <span className="ml-auto">
                <ShortcutKeys keys={["?"]} />
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* A plain link: sign-out must be a full navigation, never a prefetch. */}
            <SidebarMenuButton
              className="min-h-10"
              render={<a href="/auth/logout" />}
            >
              <LogOut aria-hidden />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

export { AppSidebar }
