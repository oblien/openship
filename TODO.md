# TODO

Deferred work and known gaps. Items are grouped by area; each carries enough
context to be picked up cold. Anchors are `file:line` at time of writing —
re-grep if they drift.

---

## SSL / ACME

### Decision: ship on certbot, switch to `lua-resty-acme` later

Current state (verified): certbot is baked into the edge image
(`apps/edge/Dockerfile:23`) and issuance runs *inside* the edge container —
`certbot certonly --standalone --http-01-port 49180` (`packages/adapters/src/infra/nginx.ts:716`),
with the edge proxying `/.well-known/acme-challenge/` to that loopback port. No
host certbot, no port-80 fight, no webroot. Renewal is driven only by
`ssl-scheduler` → `manageDomainSsl("renew")`; there is deliberately no cron
inside the image.

**This is release-safe and does not foreclose the Lua switch**, because the ACME
implementation is already behind a seam:

- `SslProvider` (`packages/adapters/src/infra/types.ts:45`) is four methods —
  `provisionCert` / `renewCert` / `installCert` / `verifyCert`. certbot appears
  in the doc comments only, never in a signature.
- `apps/api/src/lib/domain-ssl.ts` is the single service-layer entrypoint. It
  owns the per-hostname issue lock, the `tlsIssuedElsewhere` gate, and status
  persistence, and talks only to the interface.
- A second implementation already exists (`packages/adapters/src/infra/cloud.ts`),
  so the seam is exercised, not theoretical.

Why we'd switch: no subprocess, no output scraping, no Python in the image,
on-demand issuance and auto-renew handled by the edge that already owns :443.
Why not now: it moves cert storage out of the standard layout, and several
subsystems read that layout directly (below).

### What the switch actually costs

The interface is clean, but the **cert location leaked past it**. These read or
write `/etc/letsencrypt/...` directly and must be handled before or during the
migration:

- `packages/adapters/src/infra/nginx.ts` — `certsExist` / `readCertInfo`, and
  the `ssl_certificate` directives in the generated vhost.
- `packages/adapters/src/system/proxy/cert-material.ts` — cert reuse / carry.
- `packages/adapters/src/system/proxy/import/caddy-certs.ts`,
  `import/traefik-certs.ts` — adopt certs from a foreign proxy on takeover.
- `packages/adapters/src/system/proxy/ensure-container-edge.ts`,
  `docker-edge-executor.ts`, `edge-container-executor.ts`, `installer.ts` — the
  bind mount that keeps certs on the host.
- `apps/api/src/modules/migration/migration.orchestrator.ts` — cross-server cert
  carry.
- `apps/api/src/modules/domains/domain.service.ts`, `apps/api/src/lib/edge-image.ts`,
  `apps/api/src/modules/mail/mail.service.ts` (mail reuses the web cert),
  `apps/cli/src/lib/compose.ts`, `packages/db/src/schema/domain.ts`.

Cheapest path: point `lua-resty-acme` at a **filesystem storage backend using
the same `live/<domain>/{fullchain,privkey}.pem` layout**, so every reader above
keeps working and the change stays inside the provider. Do not adopt the default
shared-dict storage without first abstracting cert reads behind the provider.

Other blockers to resolve in the same change:

- [ ] **Status feedback.** `sslStatus` / `sslExpiresAt` / `sslIssuer` are written
      by the API from the provider's return value (`resolveSslPatch`,
      `domain-ssl.ts:135`). Lazy on-handshake issuance has no API-side moment to
      write those — needs a Lua→API callback, or keep issuance API-triggered and
      use resty-acme only as the ACME client.
- [ ] **Per-hostname issue lock.** `ssl:issue:<host>` (`domain-ssl.ts:19`) exists
      to stop concurrent HTTP-01 orders burning Let's Encrypt budget.
      resty-acme does its own in-process locking; decide which one is
      authoritative rather than keeping both silently.
- [ ] **`installCert` must keep working.** Operator-uploaded / Cloudflare Origin
      CA certs (`manualSsl`) are written to the same path with no ACME involved,
      and `tlsIssuedElsewhere` must keep excluding them.
- [ ] **Delete the certbot-specific workarounds** once nothing shells out:
      `--cert-name` lineage pinning and the `-0001` self-heal
      (`nginx.ts:709`), `summarizeCertbotFailure` + `certbot-summary.test.ts`,
      `ensureIssued`'s "exit 0 but no cert" backstop (`nginx.ts:765`), and the
      adopted-non-lineage branch in `renewCert` (`nginx.ts:800`).
- [ ] **Migration story for boxes already issued by certbot** — existing
      lineages and `/etc/letsencrypt/renewal` configs. With filesystem storage
      this is a no-op; with any other backend it is a data migration.

If the goal is only "get Python out of the image", **`lego`** (single Go binary)
is a much smaller change than resty-acme: same executor, same on-disk layout,
structured exit codes, contained entirely to `nginx.ts`.

---

## Auth

### SSO login for self-hosted (OIDC first, SAML only if asked for)

Not started. Goal: an operator points the instance at their IdP (Okta / Entra /
Keycloak / Authentik / Google Workspace) and staff sign in with that instead of
email + password.

What's already there:

- better-auth `^1.5.4` (`apps/api/package.json:27`), org plugin at
  `apps/api/src/lib/auth.ts:442`. The installed plugin set includes
  **`generic-oauth`** — arbitrary OIDC/OAuth2 issuers, no new dependency. That's
  the cheap path.
- Not `better-auth/plugins/oidc-provider` — that makes Openship *an* IdP, the
  opposite direction. Per-org IdPs and SAML live in the separate
  `@better-auth/sso` package, which is **not** installed; only pull it in if
  per-org IdPs or SAML are genuinely required.
- Providers are already registered only when their creds exist
  (`auth.ts:174`) — an SSO provider should follow the same env-gated shape.

The prerequisite nobody expects:

- [ ] **The button can't just be added.** Social login is hidden on self-hosted
      outright today — `{!selfHosted && <OAuthButtons/>}` at
      `apps/dashboard/src/app/(auth)/login/page.tsx:246` and
      `register/page.tsx:154` — because an operator with no `GITHUB_CLIENT_ID`
      would get buttons that fail, and **nothing tells the dashboard which
      providers are configured**. `OAuthButtons` hardcodes github+google. SSO
      needs a server-advertised provider list (public, read-only, alongside the
      `authMode`/`selfHosted` values `useAuthContext` already serves). That
      endpoint doesn't exist yet and is the real first task.

Decisions to settle before coding:

- [ ] **Account linking.** `accountLinking.trustedProviders` is
      `["github", "google"]` with `allowDifferentEmails: true`
      (`auth.ts:202-205`). An SSO provider left out of that list forks a second
      user row on first login for an email that already exists. Decide whether
      IdP-asserted email is trusted (it usually is — but say so deliberately).
- [ ] **Org + role mapping.** In team mode a fresh SSO user arrives with no
      membership and no role. Invite-only (SSO authenticates, but only into an
      org they were already invited to) is the safe default; auto-join the
      instance org needs an email-domain allowlist and a default role.
- [ ] **Zero-auth interaction.** `authMode === "none"` instances
      (`apps/api/src/lib/auth-mode.ts`) have no login at all. SSO must be inert
      there, not a second door into a box that deliberately has none.
- [ ] **Deprovisioning.** Removing someone from the IdP does not end their
      Openship session or membership. `session.expiresIn` is 30 days
      (`auth.ts:211`) — either shorten it when SSO is on, or document the gap
      honestly. There's no SCIM and shouldn't be one for v1.
- [ ] Gate on explicit env vars validated in `apps/api/src/config/env.ts`, and
      show the resolved state in Settings → security so an operator can tell SSO
      is actually live.

---

## Git providers

### Provider-agnostic git: GitLab, self-managed GitLab/Gitea/Forgejo, dumb remotes

Not started. Today "connect a repo" means GitHub, and `gitProvider` is a column
written `"github"` and then read as an assumption. Goal: make it a real
dimension — GitHub, GitLab (SaaS + self-managed), and a **dumb-remote** tier
(any HTTPS/SSH remote + a credential, no provider API) — with GitHub as one
implementation behind the seam rather than the seam itself.

What's already a seam (reuse, don't rebuild):

- `GitHubSource` + `createGitHubSource(ctx)`
  (`apps/api/src/modules/github/sources/types.ts:78`, `sources/index.ts:24`) —
  one interface, three impls (App / gh-CLI / merged local), already THE place
  source selection happens. Generalize this to `GitSource` with a provider
  dimension and most controllers don't change.
- `github.http.ts` is the single `api.github.com` primitive, so a sibling
  `gitlab.http.ts` is additive rather than surgery.
- `resolveBuildGitToken` (`modules/github/clone-auth.ts:112`) is the one clone
  credential issuer and `tokenFor` (`github.token.ts:117`) the one minter —
  provider dispatch belongs there, once, and stays unit-testable.
- Only three places branch on the column today: `project.controller.ts:955`
  (`"local"`), `clone-plan.ts:43` (`repoIsGithub`), `project-source.ts:21`
  (`"release"`).

What actually hardcodes GitHub — each is a decision, not a rename:

- [ ] **The clone URL is BUILT, not stored**: `https://github.com/${owner}/${repo}.git`
      (`modules/projects/project-crud.service.ts:219`). Any non-GitHub project
      needs its remote persisted (or a per-provider URL builder). Smallest diff,
      widest blast radius — do it first.
- [ ] **Webhooks**: `x-hub-signature-256` HMAC + GitHub's push body
      (`github.webhook.ts:127,150`, `webhook-push.ts`, `webhook-changed-files.ts`,
      `webhook-check-run.ts`). GitLab sends `X-Gitlab-Token` — a plain shared
      secret, not an HMAC — and a different payload. Extend the unified
      `webhook_delivery` table that already absorbed GitHub dedup; don't fork it.
- [ ] **Per-repo permissions** are keyed to GitHub: resource type `"github"`
      (`lib/permission.ts:52`, `lib/route-permission.ts:97,122`) and
      `assertGitHubRepoAccess` (`github-access.ts:143`). Decide between one
      `repo` resource with a provider-qualified id (a grant migration) or a
      second resource type (no migration, two gates to keep in sync forever).
- [ ] **Tarball fast path is GitHub-only** — `githubTarballUrl`
      (`packages/adapters/src/runtime/source-tarball.ts:25`). GitLab and
      Gitea/Forgejo each expose a different archive endpoint. It already falls
      back to `git clone`, so this is per-provider optional, not blocking.
- [ ] **The desktop credential relay pins the host**:
      `req.protocol !== "https" || host !== "github.com"` → reject
      (`lib/git-forwarding/relay.ts:165`). That pin is a security control, not an
      oversight. Widening it means an explicit per-provider allowlist — never a
      wildcard, and never a user-supplied host without validation.
- [ ] **SSH known-hosts are GitHub's keys** (`github-known-hosts.ts`). A
      self-managed remote needs operator-supplied host keys or a deliberate,
      documented TOFU decision.
- [ ] **Server-side git auth assumes an API to push a key to**:
      `server-git-ambient.ts`, `server-github.service.ts`,
      `packages/db/src/repos/github-deploy-key.repo.ts`. A dumb remote has no
      deploy-key endpoint — that tier is credential-only by construction.
- [ ] **Release sources**: `ReleaseSource.mode: "github" | "url"`
      (`packages/core/src/project-source.ts:30`) plus
      `api.github.com/.../releases/latest` (`lib/release-resolver.ts:183`,
      `lib/release-download.ts:163`). `mode: "url"` already covers the generic
      case; GitLab releases would be a third mode.
- [ ] **Dashboard speaks GitHub throughout**: `ServerGitHubConnect`,
      `GithubPermissionModal`, `DeployCredentialModal`, the deploy wizard's
      import step, `ResourcePicker`. Needs a server-advertised provider list —
      the SAME missing primitive as the SSO item above (`OAuthButtons` hardcodes
      github+google). Build that endpoint once and both features use it.
- [ ] **`gh` CLI as an ambient identity** (`sources/gh-cli-source.ts`,
      `github.local-auth.ts:360` parses `oauth_token` under `github.com:` in
      hosts.yml) has no equivalent worth matching. `glab` exists; decide
      deliberately whether to support it or require a PAT for GitLab.

Decisions to settle before coding:

- [ ] **Scope**: GitLab.com only, or self-managed too (custom base URL, possibly
      a private CA)? Self-managed is the harder half and the one operators
      actually ask for.
- [ ] **Is the dumb-remote tier first-class?** "Any remote + PAT" is cheap and
      covers Gitea/Forgejo/Bitbucket on day one, but it silently loses
      auto-deploy, repo listing, and per-repo grants. Ship it only if the UI says
      plainly what it can't do.
- [ ] **Make `gitProvider` a checked union** (`packages/db/src/schema/project.ts:39,115`
      — free text defaulting to `"github"`) BEFORE any second provider writes
      rows. Retrofitting a union over mixed data is the expensive order.
- [ ] **Naming trap**: `apps/api/src/modules/github/` is 26 files and the module
      path is load-bearing in imports across the API. Prefer adding
      `modules/git/` for the provider-agnostic seam and leaving GitHub as one
      implementation behind it, over a rename that touches every call site.

---

## Mail

Both items below are steps toward the same end state already sketched in
`apps/email/ARCHITECTURE.md` ("target state, not current"): openship provisions
and talks to the mail server over an **HTTP admin API**, and stops reaching into
the box. Fold changes into that doc rather than writing a competing blueprint.

### Ship the mail server as a Docker image

Today mail is a **host takeover**, not a workload. `mail.service.ts` transfers
the in-repo engine tree (`apps/email/engine/`, staged to `/root/iRedMail-engine`,
resolved via `MAIL_SERVER_ENGINE_DIR`) through a `CommandExecutor` and runs
`iRedMail.sh` on the target — which installs Postfix, Dovecot, Amavis, iRedAPD,
fail2ban **and its own Postgres** directly onto the OS. That's why mail needs a
dedicated box, why every admin action is SSH + `psql`, and why the install is a
resumable multi-step wizard instead of a pull.

The image pipeline is already there to receive it: `.github/workflows/docker-images.yml:42`
builds matrix `[api, dashboard, edge] × [amd64, arm64]` from `apps/<image>/Dockerfile`,
push-by-digest with a manifest merge. Adding mail = a Dockerfile + one matrix entry.

The blocker is that **iRedMail itself is a poor container citizen** — its
installer assumes a whole systemd OS it owns. Two honest paths:

- [ ] **Purpose-built image**: run only Postfix + Dovecot + rspamd against the
      `vmail` DB we already own via `packages/db-email`, and drop iRedMail's
      installer entirely. Matches the ARCHITECTURE.md end state (we own `vmail`;
      amavisd / iredapd / fail2ban DBs belong to upstream and would go away with
      those daemons). Most work, best result.
- [ ] **Compose the mail stack** (docker-mailserver-shaped): several containers,
      keep iRedMail's SQL map layout so Postfix/Dovecot config stays upstream's.
      Cheaper, but keeps the daemon-config surface we said we wouldn't own.

Either way, resolve before starting:

- [ ] **Host ports.** 25 / 465 / 587 / 143 / 993 must publish on the host, plus a
      matching PTR/rDNS and HELO hostname — the edge (`apps/edge`) only fronts
      80/443, so this is not "another vhost". Decide how it coexists with the
      port-takeover consent flow already built for 80/443.
- [ ] **State must be host bind mounts, not named volumes** — maildirs, the mail
      DB, DKIM keys, and `${BRANDING_PATH}/config.json`. This is the exact lesson
      the edge already paid for (hiding cert state in a named volume silently
      broke migrate/cert-carry); mail has strictly more state.
- [ ] **Cert sharing.** `mail.service.ts` reuses the web cert from the standard
      `/etc/letsencrypt` layout. In a container that becomes a mount, and it ties
      into the ACME item at the top of this file — sequence them.
- [ ] **Migration for boxes already installed by `iRedMail.sh`.** There are live
      installs; an image path that can't adopt them is a fork, not a migration.
      Scan-and-adopt already exists (`mail.routes.ts:32`) — extend it, or state
      plainly that containerized mail is new-installs-only.

### Standalone mail admin dashboard

The admin panel is currently **inseparable from openship**: `apps/api/src/modules/mail/admin/*`
drives the box over SSH and `psql` (`admin/psql-runner.ts`), and the UI lives at
`apps/dashboard/src/app/(dashboard)/emails/`. So the mail server has no
administration at all without an openship control plane attached — we deleted
iRedAdmin and put nothing self-contained in its place.

Goal: mail ships as **server image + admin image**, administrable on its own.

- [ ] **The admin API is the prerequisite, not the UI.** Every operation the
      `admin/*` services perform via SSH+psql needs an HTTP endpoint on the mail
      side first (mailboxes, domains, DNS, relay, stats, test-send). This is the
      same "openship calls the email server's admin API over HTTP" line already
      in ARCHITECTURE.md — do it once and both consumers get it.
- [ ] **Then openship's `/emails` becomes a client of that API**, not a second
      implementation. Two code paths to the same mailbox table is how they drift.
- [ ] **Auth for the standalone case.** openship authenticates its own admins
      today; a standalone admin UI needs its own login, and `vmail.mailbox`
      accounts are explicitly *not* admins (ARCHITECTURE.md identity table).
      Decide: bootstrap postmaster credential, or refuse to run standalone
      without an operator-supplied admin secret.
- [ ] Note `apps/dashboard` is **already** a standalone image
      (`apps/dashboard/Dockerfile`, in the matrix above) — this item is the *mail*
      admin UI, which does not exist as a separate artifact yet.

---

## Migrate / edge

### Adopted static roots need an explicit decision step in the CLI

**Shipped:** `unreachableStaticRoots()`
(`packages/adapters/src/system/proxy/import/index.ts`) reports adopted `static`
sites whose docroot sits outside `EDGE_CONTAINER_MOUNTS` — i.e. the paths the
containerized edge cannot read.

**Not shipped:** anything that acts on it. Found on a live 15-site migration: two
sites (`root /home/App.Front/dist/site/browser`) came up **500** —
`rewrite or internal redirection cycle while internally redirecting to
"/index.html"`, because `try_files` can't find an index in a directory that isn't
mounted. Nothing warned; the operator saw two broken sites and no reason.

- [ ] Migrate wizard: after the scan, if `unreachableStaticRoots()` is non-empty,
      show the paths and make the operator choose per site (or once for all):
      **copy** the tree under `/opt/openship/static` (already mounted — works
      immediately, but a snapshot: rebuilding the frontend needs a re-copy),
      **mount** the host path into the edge (correct long-term; costs an edge
      recreate, which blips every site on the box), or **leave** it with the 500
      spelled out. Same shape as the existing "N config items won't migrate"
      block, but a decision rather than a warning.
- [ ] Whichever action runs must rewrite the route's `staticRoot` (and the
      `<slug>.route.json` beside the vhost — `provisionCert` replays it after every
      renewal, so a root fixed only in the `.conf` reverts on renew).
- [ ] The mount path needs a way to add a bind mount without hand-editing
      `docker-compose.yml` — the edge is the one container whose mounts depend on
      what the box was serving before us.

### SSL provisioning is invisible in the deploy log

A new project's route is registered with `tls: true`, but the 443 block is only
emitted once the cert exists (`packages/adapters/src/infra/nginx.ts:594`
`route.tls && certsExist(domain)`), so there is a ~1 minute window where the site
answers HTTP and nothing on HTTPS. Verified end-to-end on a live box: cert written
`01:00:13.137`, vhost re-rendered with TLS `01:00:13.661`, `https=200` right after
— the pipeline is correct, but during the gap it is indistinguishable from broken,
and two people have now reported it as an SSL bug.

- [ ] Log it: "route live on HTTP — provisioning the certificate, HTTPS in ~1 min"
      at registration, then a line when the cert lands (or fails). Issuance is
      best-effort by design ("domains never fail a deploy"), which is exactly why
      the *silence* has to go.

---

## Runtime roles: release phase, queue workers, scheduler (#231)

An app stack declares exactly ONE `defaultStartCommand`
(`packages/core/src/stacks.ts` `StackDefinition`), so a framework whose production
shape is several processes can't express it. Laravel is the clearest case — web +
`queue:work` + `schedule:run` — and the same shape appears in Rails
(Sidekiq/Solid Queue + cron) and Django (Celery worker + beat).

**What landed** (from #231, so the gap below is narrower than the issue describes):
the PHP recipe now runs on FrankenPHP, which supervises correctly and propagates
`SIGTERM` (`packages/adapters/src/runtime/docker-build-plan.ts`
`generatePhpDockerfile`) — a worker can now be added without inheriting the old
"container stop kills the job mid-flight" problem. Persistence, PHP extensions and
the JS asset stage also landed; the storage section below has what's left of those.

### A generic release phase

Commands that run ONCE per deploy, after build and before cutover, failing the
deploy on error. `queue:work`, `schedule:run`, `migrate --force`, `optimize` and
`storage:link` appear nowhere in the tree today, so migrations, scheduled tasks
and queued jobs silently never run.

- [ ] Add release commands to the project + `openship.json`, snapshot them onto
      the deployment, and run them from the deploy pipeline between build and
      activate (`apps/api/src/modules/deployments/build-pipeline.ts` — the same
      seam `deployConfig` is assembled in).
- [ ] Laravel's set for 13.x: `migrate --force`, `optimize` (config/events/routes/
      views), `storage:link`, and `reload` (13's umbrella for cycling long-running
      services — supersedes `queue:restart` for deploys, also covers Reverb and
      Octane).
- [ ] Not the same thing as `#206` deploy hooks: those are an inbound trigger that
      STARTS a deploy; this runs DURING one.
- [ ] Until this exists, a stock SQLite Laravel app still needs its migrations run
      by hand (the service terminal can do it) — a persistent volume stops data
      LOSS, it doesn't bootstrap a schema.

### Multi-role stacks

- [ ] Decide the shape: roles declared in `StackDefinition` (worker + scheduler
      exist automatically on detection, preserving zero-config, at the cost of a
      real runtime-model change that has to compose with multi-node plans) vs.
      keeping apps single-process and pushing extras to `--type services`.
- [ ] Whichever way it goes, ANSWER IT in the docs. Auto-detection currently reads
      as "Laravel supported" while quietly omitting queues and scheduling, and
      that's the part the issue is actually complaining about.
- [ ] Cheap intermediate available today: an app project can already gain a
      second source-built unit (a `monorepo`-kind service row carries its own
      `startCommand`), and the #231 materialization keeps the web app in the
      fan-out. A "add a worker" button could write exactly that row.
- [ ] `laravel` and `symfony` (`stacks.ts`) still differ only in `name` +
      `detection`. That's correct while the recipe is generic PHP; it stops being
      correct the moment roles are per-framework.

---

## Persistent storage — remaining gaps (#231, #163, #188)

Volumes for single apps shipped (`packages/core/src/volumes.ts`,
`project.volumes`, Docker `Binds` + bare `shared/` symlinks + a cloud warn), and
object storage bindings shipped (`apps/api/src/modules/projects/project-storage.service.ts`).
What's left:

- [ ] **Backups don't cover a single app's volumes.** The backup subsystem targets
      `service` rows (`apps/api/src/modules/backups/`), so a single-app project
      with a `storage` volume has no policy that can back it up. The container's
      mounts ARE discoverable (`backup/executors/docker.ts` reads them off the
      container), so this is a targeting gap, not a capability gap.
- [ ] **Cloud has no volume primitive.** `CloudRuntime.deploy` warns and drops a
      declared mount. Either give Oblien workspaces a durable attach or make the
      UI refuse the field on a cloud target instead of warning at deploy time.
- [ ] **#163 multi-node volumes.** A stack- or project-declared path assumes the
      workload lands on the same host next time. Settle the multi-node story
      before any scheduler can move a container between boxes.
- [ ] **Non-root for the other stacks.** Only the PHP recipe drops root
      (`USER www-data`). Node/Python/Ruby/JVM/static images still run as root, each
      with its own writable-path assumptions (npm cache, `.next`, `__pycache__`,
      nginx temp dirs) — do them one stack at a time, not in one sweep.
- [ ] **A default healthcheck.** Laravel ships `/up` (configurable in
      `bootstrap/app.php`), which makes a real container healthcheck nearly free
      for that stack; compose services already support `advanced.healthcheck`.
- [ ] **Bare PHP is not supported.** The PHP start command assumes the frankenphp
      binary, and the toolchain catalog has no php/composer installer
      (`packages/adapters/src/system/modules/catalog-embedded.ts`), so PHP is
      docker-only. Fine, but say so if a user picks bare.

---

## Open TODO markers in code

Verified present; listed so they aren't lost.

- [ ] `apps/api/src/middleware/active-organization.ts:52` — active-org resolution
      has fallbacks; decide whether that's correct or whether it should be strict.
- [ ] `apps/api/src/middleware/better-auth-shield.ts:70` — audit the shield flow
      end-to-end for correctness/security.
- [ ] `apps/api/src/lib/route-permission.ts:510` — per-route `auditOnRead` flag.
- [ ] `apps/api/src/modules/projects/transfer.service.ts:339` — business-logic
      phase of project transfer, deliberately out of scope of the change that
      landed the plumbing.
- [ ] `apps/api/src/modules/system/migration/migrate-instance.service.ts:7,17` —
      trigger the actual deploy once deploy-engine integration lands (see the
      control-plane migration item below).
- [ ] `packages/adapters/src/infra/cloud.ts:22,27,34,39,44` — Oblien route + SSL
      endpoints are stubs (`POST /routes`, `DELETE /routes/:domain`,
      `POST /ssl/provision`, `POST /ssl/renew`, `GET /ssl/status`). Cloud is the
      source of truth for managed certs; until these exist, cloud SSL status is
      not readable.
- [ ] `apps/api/src/modules/deployments/cloud-resources.ts:18` — cpu/memory
      resize intentionally disabled pending the `cloud.ts` `deploy()` TODO.

---

## Known gaps — re-verify before picking up

Carried from project state, not re-verified in this pass. Confirm against the
tree first.

- [ ] **Migrate control plane → server**: phases 0+1 shipped; SSH provisioning,
      sealed transfer, and the modal/SSE surface remain.
- [ ] **Edge loopback-port routing**: allocator + schema landed; activation still
      pending real-box E2E.
- [ ] **Static sandbox build**: build ⟂ serve split landed; real-box E2E pending.
- [ ] **Cloud/self-host isolation audit**: cross-tenant leaks in shared routes +
      ingest (notably the `dump.ts` FK gap, MS Teams SSRF, verify-pending sweep,
      stale notification subscription, GitHub push fan-out).
- [ ] **Mail**: re-running DKIM key setup clobbers SES DNS records.
- [ ] **ARM64**: Linux arm64 AppImage still missing (server install is arch-safe).
- [ ] **Cloud compose**: incremental per-service add is not supported on cloud.
- [ ] **Unified app settings**: schema-driven settings UI for `isApp` projects
      (planned, not started).
- [ ] **Device auth for CLI cloud-connect** requires a SaaS redeploy to go live.
