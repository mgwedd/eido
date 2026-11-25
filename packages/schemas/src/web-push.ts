/**
 * The Web Push services the gate sends to (#789), as exact host names. This is the one list: the
 * gate refuses to register or send to a subscription whose endpoint host is not on it
 * (`push_host_refused`), and `infra/host/egress.ts` puts each host on the gate user's pf
 * allowlist. Apple's push service only, which Safari and the iPhone home-screen app use. Apple
 * documents its endpoints as any subdomain of push.apple.com, but pf matches resolved addresses
 * and cannot take a wildcard, so the list names the host Safari subscriptions use; one on any
 * other host is refused when it is registered rather than lost when it is sent.
 */
export const WEB_PUSH_HOSTS: readonly string[] = Object.freeze([
  "web.push.apple.com",
])
