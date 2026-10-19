import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@eido/ui"],
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
