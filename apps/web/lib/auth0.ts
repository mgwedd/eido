import { Auth0Client } from "@auth0/nextjs-auth0/server"

/**
 * The web app's Auth0 client. It reads AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET,
 * AUTH0_SECRET and APP_BASE_URL from the environment (see docs/auth0-setup.md).
 * APP_BASE_URL is a comma-separated list of the origins Eido is served on; the SDK checks
 * each request's origin against it. These are sign-in secrets for the web app only: core
 * and the gate never read them.
 */
export const auth0 = new Auth0Client({
  // Local-first: no SDK telemetry header on calls to Auth0.
  enableTelemetry: false,
  // The browser never needs an Auth0 access token; nothing here calls an Auth0-protected API.
  enableAccessTokenEndpoint: false,
  signInReturnToPath: "/",
  authorizationParameters: { scope: "openid profile email" },
})
