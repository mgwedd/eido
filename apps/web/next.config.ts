import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import type { NextConfig } from "next"
import { securityHeaders } from "./lib/security-headers"

// Local-first: no Next.js telemetry. Set here (not in package.json scripts) so it works on every shell.
process.env["NEXT_TELEMETRY_DISABLED"] = "1"

// `next dev` serves HMR and dev assets only to localhost and the host it binds (127.0.0.1) unless
// the origin is listed. The stack (`pnpm stack:dev`, #374) sets EIDO_TAILNET_HOST so the app also
// reloads when opened at https://<host>.ts.net:8443. Only the hostname is matched, not the port.
const tailnetHost = process.env["EIDO_TAILNET_HOST"]

// About on the Settings page: the package version and the build id (the git commit). Without git no id is baked in and the page omits the row.
function buildId(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_BUILD_ID: buildId(),
    NEXT_PUBLIC_AUTH0_ENABLED: process.env["AUTH0_DOMAIN"] ? "true" : "false",
  },
  // `next dev` rewrites apps/web/AGENTS.md on every run unless this is off (#377).
  agentRules: false,
  // `forbidden()` answers refused pages with a real 403 (app/forbidden.tsx, #370).
  experimental: { authInterrupts: true },
  transpilePackages: ["@eido/ui"],
  allowedDevOrigins: tailnetHost ? [tailnetHost] : [],
  headers() {
    return Promise.resolve([
      { source: "/:path*", headers: securityHeaders() },
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
