import type { NextConfig } from "next"

// `next dev` serves HMR and dev assets only to localhost and the host it binds (127.0.0.1) unless
// the origin is listed. The stack (`pnpm stack:dev`, #374) sets EIDO_TAILNET_HOST so the app also
// reloads when opened at https://<host>.ts.net:8443. Only the hostname is matched, not the port.
const tailnetHost = process.env["EIDO_TAILNET_HOST"]

const nextConfig: NextConfig = {
  // `next dev` rewrites apps/web/AGENTS.md on every run unless this is off (#377).
  agentRules: false,
  // `forbidden()` answers refused pages with a real 403 (app/forbidden.tsx, #370).
  experimental: { authInterrupts: true },
  transpilePackages: ["@eido/ui"],
  allowedDevOrigins: tailnetHost ? [tailnetHost] : [],
  headers() {
    return Promise.resolve([
      {
        source: "/:file(sw\\.js|sw-routing\\.js)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ])
  },
}

export default nextConfig
