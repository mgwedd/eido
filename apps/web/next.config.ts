import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@eido/ui"],
  async headers() {
    return [
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
    ]
  },
}

export default nextConfig
