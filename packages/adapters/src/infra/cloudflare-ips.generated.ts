/**
 * Cloudflare's published edge IP ranges.
 *
 * GENERATED FILE — DO NOT EDIT. Regenerate with `bun run update:cloudflare-ips` from the
 * repo root. Source: https://www.cloudflare.com/ips-v4 and /ips-v6.
 *
 * ── Why these are vendored rather than fetched ───────────────────────────────
 *
 * They are a TRUST LIST. `set_real_ip_from` grants every address in here the power to
 * rewrite a request's apparent origin, so what goes in it must be reviewable in a diff
 * and bisectable in git — not whatever a hostname answered with at boot. Fetching at
 * startup would also make the edge's config depend on outbound network at the moment it
 * comes up, and add an egress call on a box whose whole job is to accept ingress.
 *
 * Same reasoning as the vendored GeoLite2 database and the vendored world map: production
 * reads a copy we ship; the upstream URL lives only in a maintainer-time script.
 *
 * ── Why trusting them unconditionally is safe ────────────────────────────────
 *
 * `set_real_ip_from` is not "trust this header". It is "trust this header ONLY when the
 * TCP peer is one of these addresses". A visitor who sends `CF-Connecting-IP: 1.2.3.4`
 * straight at the origin is not connecting from a Cloudflare address, so nginx ignores
 * the header entirely and keeps their real peer address. That is why this list needs no
 * per-install opt-in: on a box that isn't behind Cloudflare, no peer ever matches and the
 * whole block is inert.
 *
 * Ranges change rarely (a few times a year, additive). A stale list degrades to today's
 * behaviour for traffic from a new range — wrong country for those requests — never to
 * accepting a spoofed header.
 */

/** IPv4 ranges, verbatim from https://www.cloudflare.com/ips-v4. */
export const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
] as const;

/** IPv6 ranges, verbatim from https://www.cloudflare.com/ips-v6. */
export const CLOUDFLARE_IPV6 = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

/** When this list was last refreshed from Cloudflare, for staleness reporting. */
export const CLOUDFLARE_IPS_FETCHED_AT = "2026-08-04";
