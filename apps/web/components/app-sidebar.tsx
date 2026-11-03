"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@eido/ui/components/sidebar"
import { QueuePill, useQueueCount } from "@/components/queue-count"
import { isActive, NAV_ITEMS } from "@/lib/nav"
import { queueLinkName } from "@/lib/queue/badge"

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
                {NAV_ITEMS.map(({ href, label, icon: Icon, badge }) => {
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
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}

export { AppSidebar }
