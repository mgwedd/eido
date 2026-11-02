"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut } from "lucide-react"

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
import { isActive, NAV_ITEMS } from "@/lib/nav"

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
                {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
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
                          />
                        }
                      >
                        <Icon aria-hidden />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
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
