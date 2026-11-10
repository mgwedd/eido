export interface SecurityHeader {
  key: string
  value: string
}

/**
 * Headers sent on every response. The CSP carries only the directives that cannot break the
 * PWA (no script-src, style-src, default-src or connect-src: a nonce policy needs a browser pass).
 * The Permissions-Policy switches off camera, microphone and geolocation only, so WebAuthn
 * (publickey-credentials-get), the service worker and push keep their defaults.
 */
export function securityHeaders(): SecurityHeader[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Strict-Transport-Security", value: "max-age=31536000" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    },
    {
      key: "Content-Security-Policy",
      value:
        "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    },
  ]
}
