# Oblien edge-routing requirements (for openship cloud / SaaS)

**Audience:** Oblien platform team.
**Why:** openship parses each repo's `vercel.json` routing config and, on **self-hosted**,
compiles it to OpenResty so a deployment behaves like Vercel — one domain serving static
assets at `/` and reverse-proxying a backend at `/api/*`, plus redirects/headers. On **cloud
(Oblien)** there is no OpenResty, so this config is currently **persisted but not applied**.
This doc specifies the edge capabilities Oblien needs so openship can compile the *same* config
to Oblien and reach parity. openship already has the parser, the persisted config, and a pure
compiler abstraction; only a **cloud emitter** is missing on our side, gated on the API below.

**Scope note:** this reproduces the documented `vercel.json`/Netlify **routing config**
semantics — NOT a serverless-functions runtime. openship proxies a long-running backend
service; it does not run per-file functions.

---

## IMPORTANT: this is DOMAIN/DEPLOYMENT-level routing, not a "Pages" feature

The routing table must attach to a **domain / deployment**, not only to a static Page.
openship cloud deployments come in several shapes, and all of them need edge routing:

| Deployment shape | Entry | Routing need |
|---|---|---|
| **Static-only** (Vite/CRA SPA) | a Page | SPA fallback, redirects, headers |
| **Server-only** (Express/Next API) | a **VM — no Page at all** | redirects, headers, path routing to the VM |
| **Monorepo** (static + server, e.g. Express + Vite) | **one domain over BOTH** a Page (static `/`) and a VM (`/api/*`) | proxy `/api/*` → VM, serve `/` static |
| **Compose** (N services) | one domain | path-route to several VM origins |

So each **rule's action** must be able to target: a **static artifact** (a Page/CDN bundle),
an **arbitrary origin** (a VM/service URL), or a **redirect** — independent of whether the
deployment "is a Page." A static site is just the case where the primary action serves a Page;
a server app is where it proxies a VM; a monorepo mixes both on one domain. **Do not scope the
routing table under the Pages product** — key it on the deployment/domain, or server-only and
compose deployments can never get routing and the monorepo case only works by accident (static
being the primary). Building it Pages-only now means a rework later.

---

## The one critical primitive

**Pages must reverse-proxy a path pattern to an arbitrary backend origin, on the same domain as
the static site.** Vercel (rewrites → functions/external URL), Cloudflare (Pages Functions /
`_redirects` 200-proxy) and Netlify (`status=200` proxy) all have this. Without it,
"static frontend + backend API on one domain" is impossible on cloud. Everything else is
secondary.

---

## Capabilities

### A. Per-deployment routing table
An **ordered** list of rules attached to a Page/deployment, evaluated at the edge per request.
openship sets it at deploy time. Requirements:
- **Atomic replace** on redeploy — a deploy's rules fully supersede the prior set (no partial state).
- **Scoped to the deployment** so rollback restores that deployment's rules.
- Idempotent; returns the applied config.

### B. Rule = match → action
**Match** — path pattern supporting: **exact** (`/old`), **prefix** (`/api/`), and
**wildcard/param** (`/api/*`, `:path*`, `(.*)`) with capture groups.

**Actions** (priority order):
1. **proxy → origin URL** — *must-have, the critical one.* `/api/* → https://<backend-origin>`,
   URL unchanged; forward method/body/query/headers; stream responses; ideally websocket
   upgrade; configurable keep/strip prefix (Vercel keeps).
2. **rewrite → static path** — serve a different asset, URL unchanged (powers SPA fallback
   `/* → /index.html`).
3. **redirect** — status `301/302/307/308` + destination, with capture-group substitution.
4. **response headers** — add/override headers for matching paths.
5. flags: **cleanUrls** (strip `.html`), **trailingSlash** (enforce/strip).

### C. Origin registration
A way to tell Pages the backend origin URL (the deployed backend VM/service). Inline in the
proxy rule (`origin: https://…`) is simplest; a separate `origins` registry referenced by rules
also works.

### D. Domain / TLS
One managed (`*.opsh.io`) or custom domain serving **both** static and proxied paths, with
automatic TLS (Pages already does TLS — it just needs to coexist with proxy rules).

### E. Matching semantics — documented + deterministic
State the evaluation order (first-match-wins vs longest-prefix) and the precedence between
redirects / rewrites / filesystem (Vercel: redirects → rewrites → filesystem → catch-all).
openship will emit rules in whatever order you specify.

### F. Non-functional
- Rule-count + value-length limits.
- Treat rule values as **data, not config** — they originate from untrusted repos. openship
  sanitizes at compile time, but the edge should too (reject control chars / injection).
- Per-rule hit logging is a nice-to-have.

---

## Suggested API shape (openship-facing)

Key the routing table on the **deployment / domain**, not on a Page:

```
PUT deployments/{id}/routes          // (or domains/{host}/routes) — atomic full replace
{
  routes: [
    // proxy a path to an arbitrary origin (a VM/service) — the critical primitive
    { match: { path: "/api/(.*)", type: "wildcard" },
      action: { kind: "proxy", origin: "https://backend-vm:3000", stripPrefix?: false } },
    { match: { path: "/old", type: "exact" },
      action: { kind: "redirect", status: 308, to: "/new" } },
    { match: { path: "/(.*)" },
      action: { kind: "headers", set: [{ key: "X-Frame-Options", value: "DENY" }] } },
    // serve a static artifact (a Page/CDN bundle) — SPA fallback
    { match: { path: "/(.*)" },
      action: { kind: "static", target: "index.html" } }
  ],
  cleanUrls?: boolean,
  trailingSlash?: boolean
}
```
Action `kind` is one of `proxy` (→ any origin URL), `static` (→ a Page/CDN artifact),
`redirect`, `rewrite`, `headers` — so the SAME table works for static-only, server-only,
monorepo, and compose deployments. Return the applied config; idempotent; a version pinned to
the openship deployment so rollback restores that deployment's routes.

---

## How openship maps to it (already built on our side)

openship parses `vercel.json` → a normalized `RoutingConfig`
(`rewrites`/`redirects`/`headers`/`cleanUrls`/`trailingSlash`), persists it on the project, and
compiles it — today to OpenResty (`compileVercelRouting`, self-hosted). To light up cloud we add
one **cloud emitter** over the SAME `RoutingConfig`, mapping:
- `rewrites` (dest = path/function) → `proxy` to backend origin · (dest = `/index.html`) →
  `rewrite` · (dest = full URL) → `proxy` to that URL
- `redirects` → `redirect` · `headers` → `headers` · `cleanUrls`/`trailingSlash` → flags

So self-hosted (OpenResty locations) and cloud (Oblien routes) become two emitters over one
parsed config — genuine parity.

---

## MVP (phaseable)

1. **proxy-to-origin** (C + action #1) — mandatory.
2. static **rewrite / SPA fallback** (#2) — mandatory.
3. **redirects** (#3) + **headers** (#4).
4. Later: `cleanUrls`/`trailingSlash`; conditional matching (Vercel `has`/`missing`); per-rule logging.

Items 1–2 alone deliver the Vercel "static + `/api`" single-domain behavior on cloud; item 3
rounds out the common `vercel.json`.

---

## Service-to-service networking (compose / monorepo backends)

Separate from edge routing: a multi-service deployment (docker-compose, or a monorepo whose
frontend proxies to a backend) needs its workspaces to reach **each other** internally — e.g. the
frontend calling `http://api:3000`. On native Docker this is automatic (embedded DNS + shared
network). On Oblien each service is its own workspace on the internal `10.x` network, so openship
must wire three things, and **all three are required** for a call to connect:

1. **Source rule — `private_link_ids` (directed).** Adding workspace A to B's `private_link_ids`
   authorizes **A → B** (one-way). openship sets every service's list to all its peers, so the
   mesh is bidirectional.
2. **Port rule — `ingress_ports`.** A private link does **NOT** open any port. Per Oblien's
   firewall, *"traffic is dropped unless all match … Port is in the `ingress_ports` list — only
   ports you explicitly open are reachable."* So **each service's own listen port must also be in
   its `ingress_ports`**, or a linked peer's connection is silently dropped. openship opens each
   service's port here (`syncServiceDiscovery`) alongside the link — a link without the matching
   port open is the classic footgun.
3. **Name resolution — `/etc/hosts`.** There is **no internal DNS**, so a hostname like `api`
   does not resolve on its own. openship `exec`s into each workspace and writes
   `<peer-ip> <service-name>` lines to `/etc/hosts` so `http://api:3000` resolves to the peer's
   internal IP.

**Ask for the Oblien team:** the source/port/DNS split is currently only discoverable by reading
`workspace-networking.md` closely, and internal hostname resolution isn't documented at all. Two
concrete improvements would make this "clear end-to-end": (a) document that a private link leaves
the target port closed unless it's in `ingress_ports` (state it at the private-link API, not only
in the firewall concepts page), and (b) document (or provide) internal name resolution so callers
don't have to hand-roll `/etc/hosts`. Ideally, linking two workspaces for a known service port
would open that port and register the name in one call.

## Canonical hostname redirects: verified provider gap (2026-10-15)

The wizard offers bare-domain or www primary selection on Cloud and self-hosted
edges. Per the release decision, Openship assumes the provider fix described below
and uses the existing redirect API contract; it does not expose this provider issue
in the customer UI. These are the pre-fix live observations, not confirmation that
Oblien has deployed the fix. This differs from query-string preservation: live tests confirmed that queries survive today,
but wildcard captures are taken from a decoded path.

Reproduction using an owned temporary EdgeTunnel hostname and `routes.set`:

```json
{
  "routes": [{
    "match": { "path": "/(.*)", "type": "wildcard" },
    "action": { "kind": "redirect", "status": 301, "to": "https://primary.example.com/$1" }
  }]
}
```

The pre-fix probe of `/docs/a%2Fb?x=1&x=2&encoded=a%2Bb` redirected to
`https://primary.example.com/docs/a/b?x=1&x=2&encoded=a%2Bb`.
The encoded slash has changed meaning. Encoded Unicode paths also become raw
header bytes. `$request_uri`, `${request_uri}`, `{request_uri}` and `$raw_uri`
are emitted literally, so Nginx variable syntax is not an available workaround.
The temporary resources used for these checks were deleted; no VM or customer
route was changed.

The existing `/(.*)` redirect rule with `https://<target>/$1` must preserve the raw
original escaped path and query when changing hostnames. It must append the
untouched path and query exactly once to the validated destination origin, without decoding,
normalizing, re-encoding captures, or accepting a user-supplied destination host.
Keep path matching and rule precedence consistent with the documented API.
If a new action or option is required instead of fixing the existing rule, its
contract must be provided so `CloudInfraProvider.registerRoute` can be updated;
Openship currently sends the existing wildcard redirect rule. Keep each hostname's
existing project-owned Page anchor, DNS ownership verification, TLS lifecycle, and same-project redirect
validation.

When verifying the provider fix, check both directions and HTTP
301/302/307/308 with `/`, `%2F`, `%25`, UTF-8 escapes, repeated query keys,
encoded query delimiters, empty parameters and trailing slashes. Re-saving and
retrying routing must remain idempotent; Serve both must remove the redirect.
