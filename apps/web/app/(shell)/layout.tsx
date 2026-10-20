import { SidebarProvider } from "@eido/ui/components/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { ConnectionBanner } from "@/components/connection-banner"
import { PhoneTabBar } from "@/components/phone-tab-bar"

export default function ShellLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <SidebarProvider
      className="min-h-svh"
      style={{ "--sidebar-width": "14.5rem" } as React.CSSProperties}
    >
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Skip to content
      </a>
      <AppSidebar />
      <PhoneTabBar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <main
          id="main"
          tabIndex={-1}
          className="flex flex-1 flex-col gap-5 p-4 pb-[calc(52px+env(safe-area-inset-bottom)+1rem)] outline-none md:px-8 md:pt-6 md:pb-12"
        >
          {children}
        </main>
      </div>
    </SidebarProvider>
  )
}
