import { CORE_ROLE_REFRESH_PATH } from "@/lib/auth/core-role"

const CORE_PREFIX = "/api/core/"

type Fetch = typeof fetch

function requestPath(input: Parameters<Fetch>[0]): string | null {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  try {
    return new URL(raw, "http://eido.invalid").pathname
  } catch {
    return null
  }
}

/** Whether `response` is core refusing for want of a valid role assertion. */
async function isUnauthenticated(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown }
    }
    return body.error?.code === "unauthenticated"
  } catch {
    return false
  }
}

/**
 * Wraps `fetch` so a core request refused with 401 `unauthenticated` (the role assertion cookie
 * is missing or has lapsed, ADR 0010) gets a fresh cookie from the web app and is sent again,
 * once. A second 401 is returned as is, so a lost Auth0 session surfaces as before. Requests
 * that are not to /api/core, and every other response, pass through untouched.
 */
export function withCoreRoleRefresh(base: Fetch): Fetch {
  return async (input, init) => {
    const response = await base(input, init)
    const path = requestPath(input)
    if (!path?.startsWith(CORE_PREFIX) || !(await isUnauthenticated(response)))
      return response
    try {
      const refreshed = await base(CORE_ROLE_REFRESH_PATH, {
        method: "POST",
        cache: "no-store",
      })
      if (!refreshed.ok) return response
    } catch {
      return response
    }
    return base(input, init)
  }
}
