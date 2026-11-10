import { Auth0Client } from "@auth0/nextjs-auth0/server"

/** Whether Auth0 authentication is configured. When unset, Eido uses passkey-first sign-in (issue 679). */
export const isAuth0Enabled = (): boolean =>
  Boolean(process.env["AUTH0_DOMAIN"])

/**
 * The web app's Auth0 client. It reads AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET,
 * AUTH0_SECRET and APP_BASE_URL from the environment (see docs/auth0-setup.md).
 * APP_BASE_URL is a comma-separated list of the origins Eido is served on; the SDK checks
 * each request's origin against it. These are sign-in secrets for the web app only: core
 * and the gate never read them.
 * Null when Auth0 is not enabled.
 */
export const auth0: Auth0Client | null = isAuth0Enabled()
  ? new Auth0Client({
      // Local-first: no SDK telemetry header on calls to Auth0.
      enableTelemetry: false,
      // The browser never needs an Auth0 access token; nothing here calls an Auth0-protected API.
      enableAccessTokenEndpoint: false,
      signInReturnToPath: "/",
      session: {
        // Explicit rather than SDK defaults: the cookie is not sent cross-site on POST, and the
        // session lives at most 3 days, ending after 1 day without use. `secure` is left to the
        // SDK, which sets it per origin: APP_BASE_URL also lists http://localhost on the Mac.
        cookie: { sameSite: "lax" },
        rolling: true,
        absoluteDuration: 60 * 60 * 24 * 3,
        inactivityDuration: 60 * 60 * 24,
      },
      authorizationParameters: { scope: "openid profile email" },
    })
  : null
