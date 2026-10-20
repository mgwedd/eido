/* eslint-disable no-unused-vars -- both functions are used by sw.js and the tests */
/*
 * Request routing rules for the service worker. A classic script: sw.js loads it
 * with importScripts, and the unit test evaluates this file as text, so keep it
 * free of imports, exports and browser globals.
 *
 * classifyRequest returns one of:
 *   "static"       build assets and icons: cache first
 *   "navigation"   page loads: network first, cached shell when offline
 *   "api-read"     read-only API GETs: network first, cached copy when offline
 *   "network-only" everything else: never read from or written to the cache
 */

var SENSITIVE_SEGMENTS = [
  "nonce",
  "nonces",
  "approval",
  "approvals",
  "approve",
  "sign",
  "signing",
  "signature",
  "passkey",
  "passkeys",
  "webauthn",
  "auth",
  "enrol",
  "enroll",
  "unlock",
]

var NETWORK_ONLY_PATHS = ["/healthz", "/sw.js", "/sw-routing.js"]

var STATIC_PATH =
  /^\/(_next\/static\/|manifest\.webmanifest$|favicon\.ico$|icon\/|apple-icon)/

function classifyRequest(request) {
  if (request.method !== "GET") return "network-only"

  var url = new URL(request.url)
  if (url.origin !== request.origin) return "network-only"

  var path = url.pathname
  if (NETWORK_ONLY_PATHS.indexOf(path) !== -1) return "network-only"

  var segments = path.toLowerCase().split("/")
  for (var i = 0; i < segments.length; i++) {
    if (SENSITIVE_SEGMENTS.indexOf(segments[i]) !== -1) return "network-only"
  }

  if (STATIC_PATH.test(path)) return "static"
  if (request.mode === "navigate") return "navigation"
  if (path.indexOf("/api/") === 0) {
    return request.hasAuthorization ? "network-only" : "api-read"
  }
  return "network-only"
}

/** Only complete, same-origin, cacheable responses are stored. */
function isCacheableResponse(response) {
  if (response.status !== 200 || response.type !== "basic") return false
  return !/no-store/i.test(response.cacheControl || "")
}
