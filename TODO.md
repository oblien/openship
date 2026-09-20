# TODO

Deferred work and known gaps. Items are grouped by area; each carries enough
context to be picked up cold. Anchors are `file:line` at time of writing —
re-grep if they drift.

Every item below was verified against the tree on 2026-08-20. Shipped work was
removed, and items that mis-described the code were rewritten rather than left to
mislead. If you add an item, say what would make it removable.

---

## SSL / ACME

### Decision: ship on certbot, switch to `lua-resty-acme` later

Current state (re-verified): certbot is baked into the edge image
(`apps/edge/Dockerfile`) and issuance runs *inside* the edge container —
`certbot certonly --standalone --http-01-port 49180` (`packages/adapters/src/infra/nginx.ts`),
with the edge proxying `/.well-known/acme-challenge/` to that loopback port. No
host certbot, no port-80 fight, no webroot. Renewal is driven only by
`ssl-scheduler` → `manageDomainSsl("renew")`; there is deliberately no cron
inside the image. **Nothing in the tree references resty-acme** — the switch has
not started, so every blocker below is untouched rather than partly done.

**This is release-safe and does not foreclose the Lua switch**, because the ACME
implementation is already behind a seam:

- `SslProvider` (`packages/adapters/src/infra/types.ts`) is four methods —
  `provisionCert` / `renewCert` / `installCert` / `verifyCert`. certbot appears
  in the doc comments only, never in a signature.
- `apps/api/src/lib/domain-ssl.ts` is the single service-layer entrypoint. It
  owns the per-hostname issue lock, the `tlsIssuedElsewhere` gate, and status
  persistence, and talks only to the interface.
- A second implementation already exists (`packages/adapters/src/infra/cloud.ts`),
  so the seam is exercised, not theoretical. (Note its route/SSL methods are
  stubs — see "Open TODO markers".)

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
  `apps/api/src/modules/mail/mail.service.ts`, `packages/adapters/src/infra/mail-container.ts`
  (mail reuses the web cert — it is a `/etc/letsencrypt` bind mount into the mail
  container now), `apps/cli/src/lib/compose.ts`, `packages/db/src/schema/domain.ts`.

Cheapest path: point `lua-resty-acme` at a **filesystem storage backend using
the same `live/<domain>/{fullchain,privkey}.pem` layout**, so every reader above
keeps working and the change stays inside the provider. Do not adopt the default
shared-dict storage without first abstracting cert reads behind the provider.

Other blockers to resolve in the same change:

- [ ] **Status feedback.** `sslStatus` / `sslExpiresAt` / `sslIssuer` are written
      by the API from the provider's return value (`resolveSslPatch` in
      `apps/api/src/lib/domain-ssl.ts`). Lazy on-handshake issuance has no
      API-side moment to write those — needs a Lua→API callback, or keep issuance
      API-triggered and use resty-acme only as the ACME client.
- [ ] **Per-hostname issue lock.** The `ssl:issue:<host>` lock in `domain-ssl.ts`
      exists to stop concurrent HTTP-01 orders burning Let's Encrypt budget.
      resty-acme does its own in-process locking; decide which one is
      authoritative rather than keeping both silently.
- [ ] **`installCert` must keep working.** Operator-uploaded / Cloudflare Origin
      CA certs (`manualSsl`) are written to the same path with no ACME involved,
      and `tlsIssuedElsewhere` must keep excluding them.
- [ ] **Delete the certbot-specific workarounds** once nothing shells out:
      `--cert-name` lineage pinning and the `-0001` self-heal, the
      `summarizeCertbotFailure` helper + `certbot-summary.test.ts`, `ensureIssued`'s
      "exit 0 but no cert" backstop, and the adopted-non-lineage branch in
      `renewCert` — all in `nginx.ts`.
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

- better-auth with the org plugin in `apps/api/src/lib/auth.ts`. The installed
  plugin set includes **`generic-oauth`** — arbitrary OIDC/OAuth2 issuers, no new
  dependency. That's the cheap path.
- Not `better-auth/plugins/oidc-provider` — that makes Openship *an* IdP, the
  opposite direction. Per-org IdPs and SAML live in the separate
  `@better-auth/sso` package, which is **not** installed; only pull it in if
  per-org IdPs or SAML are genuinely required.
- Providers are already registered only when their creds exist, so an SSO
  provider should follow the same env-gated shape.

The prerequisite nobody expects:

- [ ] **The button can't just be added.** Social login is hidden on self-hosted
      outright today — `{!selfHosted && <OAuthButtons/>}` at
      `apps/dashboard/src/app/(auth)/login/page.tsx:312` and
      `register/page.tsx` — because an operator with no `GITHUB_CLIENT_ID`
      would get buttons that fail, and **nothing tells the dashboard which
      providers are configured**. `OAuthButtons` hardcodes github+google. SSO
      needs a server-advertised provider list (public, read-only, alongside the
      `authMode`/`selfHosted` values `useAuthContext` already serves). That
      endpoint doesn't exist yet and is the real first task.

Decisions to settle before coding:

- [ ] **Account linking.** `accountLinking.trustedProviders` is
      `["github", "google"]` with `allowDifferentEmails: true` in `auth.ts`. An
      SSO provider left out of that list forks a second user row on first login
      for an email that already exists. Decide whether IdP-asserted email is
      trusted (it usually is — but say so deliberately).
- [ ] **Where an SSO user LANDS.** The invite-only gate itself is already
      shipped, so this is narrower than it looks: `databaseHooks.user.create.before`
      (`auth.ts:262-306`) enforces invite-only sign-up on self-hosted for the
      OAuth/social path, and a fresh user gets a personal-org owner membership
      with role `user`. What is undecided is the SSO-specific half — an
      IdP-authenticated user currently lands in a *personal workspace*, not the
      team org, and there is no email-domain allowlist and no default team role.
- [ ] **Zero-auth interaction.** `authMode === "none"` instances
      (`apps/api/src/lib/auth-mode.ts`) have no login at all. SSO must be inert
      there, not a second door into a box that deliberately has none.
- [ ] **Deprovisioning.** Removing someone from the IdP does not end their
      Openship session or membership. `session.expiresIn` is 30 days — either
      shorten it when SSO is on, or document the gap honestly. There's no SCIM
      and shouldn't be one for v1.
- [ ] Gate on explicit env vars validated in `apps/api/src/config/env.ts`, and
      show the resolved state in Settings → security so an operator can tell SSO
      is actually live.

---

## Git providers

### Provider-agnostic git: GitLab, self-managed GitLab/Gitea/Forgejo, dumb remotes

Not started — **no second provider exists anywhere on disk**. Today "connect a
repo" means GitHub, and `gitProvider` is a column written `"github"` and then
read as an assumption. Goal: make it a real dimension — GitHub, GitLab (SaaS +
self-managed), and a **dumb-remote** tier (any HTTPS/SSH remote + a credential,
no provider API) — with GitHub as one implementation behind the seam rather than
the seam itself.

What's already a seam (reuse, don't rebuild):

- `GitHubSource` + `createGitHubSource(ctx)`
  (`apps/api/src/modules/github/sources/types.ts`, `sources/index.ts`) — one
  interface, three impls (App / gh-CLI / merged local), already THE place source
  selection happens. Generalize this to `GitSource` with a provider dimension and
  most controllers don't change.
- `github.http.ts` is the single `api.github.com` primitive, so a sibling
  `gitlab.http.ts` is additive rather than surgery.
- `resolveBuildGitToken` (`modules/github/clone-auth.ts`) is the one clone
  credential issuer and `tokenFor` (`github.token.ts`) the one minter — provider
  dispatch belongs there, once, and stays unit-testable.
- Only three places branch on the column today: `project.controller.ts`
  (`"local"`), `clone-plan.ts` (`repoIsGithub`), `project-source.ts` (`"release"`).

What actually hardcodes GitHub — each is a decision, not a rename:

- [ ] **The clone URL is BUILT, not stored**: `projectGitUrl(owner, repo)` at
      `apps/api/src/modules/projects/project-crud.service.ts:409` returns
      `https://github.com/<owner>/<repo>.git`, called at :434, :851, :869, :921.
      Any non-GitHub project needs its remote persisted (or a per-provider URL
      builder). Smallest diff, widest blast radius — do it first.
- [ ] **Webhooks**: `x-hub-signature-256` HMAC + GitHub's push body
      (`github.webhook.ts`, `webhook-push.ts`, `webhook-changed-files.ts`,
      `webhook-check-run.ts`). GitLab sends `X-Gitlab-Token` — a plain shared
      secret, not an HMAC — and a different payload. Extend the unified
      `webhook_delivery` table that already absorbed GitHub dedup; don't fork it.
- [ ] **Per-repo permissions** are keyed to GitHub: resource type `"github"`
      (`lib/permission.ts`, `lib/route-permission.ts`) and
      `assertGitHubRepoAccess` (`github-access.ts`). Decide between one `repo`
      resource with a provider-qualified id (a grant migration) or a second
      resource type (no migration, two gates to keep in sync forever).
- [ ] **Tarball fast path is GitHub-only** — `githubTarballUrl`
      (`packages/adapters/src/runtime/source-tarball.ts`). GitLab and
      Gitea/Forgejo each expose a different archive endpoint. It already falls
      back to `git clone`, so this is per-provider optional, not blocking.
- [ ] **The desktop credential relay pins the host**: a non-https or
      non-`github.com` request is rejected (`lib/git-forwarding/relay.ts`). That
      pin is a security control, not an oversight. Widening it means an explicit
      per-provider allowlist — never a wildcard, and never a user-supplied host
      without validation.
- [ ] **SSH known-hosts are GitHub's keys** (`github-known-hosts.ts`). A
      self-managed remote needs operator-supplied host keys or a deliberate,
      documented TOFU decision.
- [ ] **Generalize the server-side credential RESOLVER** (narrower than it used
      to read here). `server-git-ambient.ts` is already provider-agnostic — it
      takes an opaque `repoUrl` and runs `git ls-remote` through the shared
      `assembleGitClone`, with no API call and no key written; it sits in
      `modules/github/` by file placement only. In `server-github.service.ts`
      only `ensureDeployKey` pushes a key to an API; `ensureServerKey` just mints
      an ed25519 pair. So the work is the resolver + the mode→field map (drop the
      `api.github.com/user` token validation for a non-GitHub token).
      `github-deploy-key.repo.ts` and the deploy-key path stay GitHub-only by
      construction — a dumb remote has no deploy-key endpoint, so that tier is
      credential-only.
- [ ] **Release sources**: `ReleaseSource.mode: "github" | "url"`
      (`packages/core/src/project-source.ts`) plus the `releases/latest` calls in
      `lib/release-resolver.ts` and `lib/release-download.ts`. `mode: "url"`
      already covers the generic case; GitLab releases would be a third mode.
- [ ] **Dashboard speaks GitHub throughout**: `ServerGitHubConnect`,
      `GithubPermissionModal`, `DeployCredentialModal`, the deploy wizard's
      import step, `ResourcePicker`. Needs a server-advertised provider list —
      the SAME missing primitive as the SSO item above (`OAuthButtons` hardcodes
      github+google). Build that endpoint once and both features use it.
- [ ] **`gh` CLI as an ambient identity** (`sources/gh-cli-source.ts`,
      `github.local-auth.ts` parses `oauth_token` under `github.com:` in
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
- [ ] **Make `gitProvider` a checked union.** The canonical set already exists —
      `SOURCE_PROVIDERS` + `SourceProvider` in `packages/core/src/project-source.ts`,
      and `packages/db/src/schema/project.ts:113-114` documents it as canonical —
      but **nothing validates against it**. The column is still free text
      defaulting to `"github"` at `project.ts:47` (project-level) and `:123`
      (environment-level), with no CHECK in any migration, and the API accepts any
      string (`project.schema.ts` `gitProvider: Type.Optional(Type.String(...))`).
      No second provider writes rows yet, so this is still the cheap moment —
      retrofitting a union over mixed data is the expensive order.
- [ ] **Naming trap**: `apps/api/src/modules/github/` is **29 top-level files
      (35 including `sources/`)** and the module path is load-bearing in imports
      across the API. Prefer adding `modules/git/` for the provider-agnostic seam
      and leaving GitHub as one implementation behind it, over a rename that
      touches every call site. `modules/git/` does not exist yet.

---

## Mail

The end state is sketched in `apps/email/ARCHITECTURE.md` ("target state, not
current"): openship provisions and talks to the mail server over an **HTTP admin
API**, and stops reaching into the box. Fold changes into that doc rather than
writing a competing blueprint.

### Already shipped — do not re-plan it

Mail is **no longer a host takeover**; it ships as an image and the API no longer
transfers the engine tree or shells `iRedMail.sh`. `openship-mail` + a pinned
`postgres:16-alpine` sidecar, launched by raw `docker run` on `--network host`
(`infra/mail-container.ts`, `system/mail/ensure-container-mail.ts`), in the
`docker-images.yml` matrix alongside `webmail`. Host ports, host-bind-mount state
and `/etc/letsencrypt` cert sharing are all settled there. Two consequences remain:

### Engine image: the debt the shipped path took on

- [ ] **The image still runs iRedMail's installer at BUILD time** and keeps the
      full upstream daemon set (postfix, dovecot, amavis, clamav, spamd, iredapd,
      fail2ban under `apps/email/docker/supervisord.conf`). The narrow ambition —
      own only Postfix + Dovecot + rspamd against the `vmail` DB we already own
      via `packages/db-email`, and drop the installer — is untouched, and it is now
      a **rewrite of a shipped image**, not a choice of how to ship one. There is
      no rspamd anywhere outside the vendored engine tree. This is the
      daemon-config surface we said we wouldn't own; decide whether we ever pay it
      down or accept it.
- [ ] **Remove the dead `MAIL_SERVER_ENGINE_DIR` plumbing.** Nothing reads it any
      more; `apps/cli/src/commands/up.ts` and `apps/desktop/src/main/services.ts`
      still set it for nothing. (The stale file headers it came with are fixed.)
- [ ] **No host→container migration exists.** Legacy `iRedMail.sh` boxes are
      first-class instead: `detect-engine.ts` defines flavor
      `"container" | "host" | "none"` as the one topology probe, and
      `mail-engine.ts` makes SQL transport, daemon probes, actions and config
      paths a pure function of it — so the admin panel, health tab and backups all
      still drive a host-native install. Scan-and-adopt (`mail.routes.ts:33-34`)
      is flavor-agnostic but adopts a DB row; it does not convert a topology.
      Needed: either a real migration (move maildirs + `vmail` into the
      container/sidecar) or a **stated product position** that containerized mail
      is new-installs-only. Today that position exists only as a code comment in
      `detect-engine.ts:11-13`, not in the setup UI.

### Standalone mail admin dashboard

The admin panel is currently **inseparable from openship**:
`apps/api/src/modules/mail/admin/*` drives the box over SSH and `psql`
(`admin/psql-runner.ts` — "All vmail.* reads and writes go through this module"),
and the UI lives at `apps/dashboard/src/app/(dashboard)/emails/`. So the mail
server has no administration at all without an openship control plane attached —
we deleted iRedAdmin and put nothing self-contained in its place.

Goal: mail ships as **server image + admin image**, administrable on its own.

- [ ] **The admin API is the prerequisite, not the UI.** The mail-side HTTP
      server (`apps/email/server/src/main.ts`) mounts exactly three route
      families: `/auth` (IMAP-backed mailbox sign-in), `/mail` (IMAP IDLE SSE),
      and `/admin` — which is **branding only**
      (`routes/branding-admin.ts`, token-gated by `BRANDING_ADMIN_TOKEN`). None of
      mailboxes, domains, DNS, relay, stats or test-send has a mail-side endpoint;
      every one is still an SSH+psql call from openship. `ARCHITECTURE.md` still
      states the as-built position: "There is intentionally **no public admin
      subdomain** … No HTTP admin surface to firewall, no token to rotate" — so
      this item is a reversal of a deliberate decision, and should be argued as
      one.
- [ ] **Then openship's `/emails` becomes a client of that API**, not a second
      implementation. (Today there is exactly ONE implementation — openship's
      SSH+psql — so the drift this warns about is prospective, not current.)
- [ ] **Auth for the standalone case.** Mail-side auth is mailbox auth only
      ("the IMAP server is the identity provider"); there is no admin identity,
      no admin login, and `vmail.mailbox` accounts are explicitly *not* admins
      (`ARCHITECTURE.md` identity table). Decide: bootstrap postmaster credential,
      or refuse to run standalone without an operator-supplied admin secret. The
      `BRANDING_ADMIN_TOKEN` pattern is the nearest precedent and covers branding
      text only.
- [ ] Scoping note, still accurate: `apps/dashboard` is **already** a standalone
      published image and `apps/email/` already produces TWO images (engine +
      webmail) — but there is no mail-admin Dockerfile and no matrix entry. This
      is context for the three items above, not work to check off.

---

## Migrate / edge

### Adopted static roots: the mount option, and the dashboard

**Shipped:** `unreachableStaticRoots()`
(`packages/adapters/src/system/proxy/import/index.ts`) reports adopted `static`
sites whose docroot sits outside `EDGE_CONTAINER_MOUNTS`, and
`remediateUnreachableStaticRoots()` (`apps/cli/src/lib/edge-preflight.ts:711`) is
the one remediation presenter shared by the compose preflight and the bare wizard
(#456): it lists every host→root pair, warns they would 500 after cutover, and
makes the operator choose. The chosen root is substituted at the single writer
(`proxy/takeover.ts:155`) and persisted into `<slug>.route.json`
(`infra/nginx.ts:1969`), so it survives the `provisionCert` replay on renewal.

Original symptom, for context: on a live 15-site migration two sites
(`root /home/App.Front/dist/site/browser`) came up **500** —
`rewrite or internal redirection cycle while internally redirecting to
"/index.html"` — because `try_files` can't find an index in a directory that
isn't mounted, and nothing warned.

- [ ] **The `mount` option is not offered.** The select has exactly two branches,
      copy or leave, and "leave" tells the operator to mount the directory by
      hand. Copy works immediately but is a snapshot — rebuilding the frontend
      needs a re-copy. Mounting is the correct long-term answer and depends on the
      item below.
- [ ] **A way to add an edge bind mount without hand-editing
      `docker-compose.yml`.** The edge is the one container whose mounts depend on
      what the box was serving before us, and adding one costs an edge recreate
      (which blips every site). This blocks the `mount` branch above.
- [ ] **No dashboard equivalent.** The prompt exists only in the CLI wizard;
      grepping `unreachableStaticRoots` / `staticRoot` across `apps/dashboard/src`
      returns nothing, so a dashboard-driven migration still hits the 500 silently.

### SSL provisioning: the reassurance line is still missing

A new project's route is registered with `tls: true`, but the 443 block is only
emitted once the cert exists (`nginx.ts`, `route.tls && certsExist(domain)`), so
there is a ~1 minute window where the site answers HTTP and nothing on HTTPS.
Verified end-to-end on a live box: cert written `01:00:13.137`, vhost re-rendered
with TLS `01:00:13.661`, `https=200` right after — the pipeline is correct, but
during the gap it is indistinguishable from broken, and two people have now
reported it as an SSL bug.

**Shipped since:** the outcome half. `createTrackedSslProvider`
(`apps/api/src/lib/routing-domains.ts`) logs `Requesting SSL certificate for
<host>…`, then `SSL certificate active — <host> is Live.` or `SSL not issued for
<host> — marked Action Required … Reason: …` into the deploy log.

- [ ] **Say the gap is expected.** Nothing tells the operator the route is
      ALREADY serving on HTTP and that HTTPS is ~1 minute away — which is the
      whole point, since issuance is best-effort by design ("domains never fail a
      deploy"). "Requesting SSL certificate for X…" does not convey it. The only
      text with that framing is a `console.log` (server stdout, not the deployment
      log) on the cloud domain-verify path.

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
      `StackDefinition` still has exactly one `defaultStartCommand` and no roles
      field.
- [ ] Whichever way it goes, ANSWER IT in the docs. Auto-detection currently reads
      as "Laravel supported" while quietly omitting queues and scheduling, and
      that's the part the issue is actually complaining about.
- [ ] Cheap intermediate available today: an app project can already gain a
      second source-built unit (a `monorepo`-kind service row carries its own
      `startCommand`), and the #231 materialization keeps the web app in the
      fan-out. A "add a worker" button could write exactly that row.
- [ ] `laravel` and `symfony` (`stacks.ts`) now differ in `name`, `detection` and
      `persistentPaths` (laravel declares `["storage"]`; symfony declares none,
      because `var/` is regenerated cache+logs and it has no upload convention).
      Everything else — language, category, `outputDirectory: "public"`, port,
      empty build command, the byte-identical FrankenPHP start command — is shared.
      A per-framework divergence has therefore already begun, which is the point:
      it stops being correct to share the recipe the moment roles are
      per-framework.

---

## Persistent storage — remaining gaps (#231, #163, #188)

Volumes for single apps shipped (`packages/core/src/volumes.ts`,
`project.volumes`), and object storage bindings shipped
(`apps/api/src/modules/projects/project-storage.service.ts`). Re-verified
2026-08-20 — **every item below is still open**:

- [ ] **Backups don't cover a single app's volumes.** The backup subsystem targets
      `service` rows: the project-default fan-out is
      `repos.service.listByProject(...)` and throws `"Project has no services to
      back up"` on zero services
      (`apps/api/src/modules/backups/backup.orchestrator.ts:163-165`), with the
      execute path re-asserting it. A true single-app project has ZERO service rows
      (the #231 app row is only materialized once a `compose` sidecar exists), so a
      project with `project.volumes` set has no policy that can back it up — and a
      policy CAN be saved with `serviceId: null`, so the failure lands at first run,
      not at save. It is purely a TARGETING gap: the docker executor already reads
      mounts off the live container. Fix needs a project-level/app source kind, or
      a fan-out that synthesizes the app unit (`project.volumes` resolves via
      `appRowVolumes`).
- [ ] **Cloud has no volume primitive.** `CloudRuntime.deploy` still warns and
      drops a declared mount (`packages/adapters/src/runtime/cloud.ts:1637-1648`,
      "Oblien has no volume primitive"). Neither alternative shipped: the API
      accepts `volumes` on any project with no target check, and the dashboard's
      `StorageSettings` has no cloud gating. Either give Oblien workspaces a
      durable attach or make the UI refuse the field on a cloud target instead of
      warning at deploy time.
- [ ] **#163 multi-node volumes.** A stack- or project-declared path assumes the
      workload lands on the same host next time. There is no scheduler or cluster
      primitive to constrain yet, and volume resolution is single-host by
      construction (`volume-namespace.ts` scopes per project slug, no node
      dimension). The public roadmap marks "Shared volumes across nodes" as
      *planned* — intent, not a settled story. Settle it before any scheduler can
      move a container between boxes.
- [ ] **Non-root for the other stacks.** `docker-build-plan.ts` has exactly one
      `USER` directive — `USER www-data` at :309, inside `generatePhpDockerfile`.
      `generateStaticDockerfile` and the generic `generateDockerfile`
      (Node/Python/Ruby/JVM/C#/Elixir/Go/Rust) emit none, so those all run as root
      with no writable-path prep (npm cache, `.next`, `__pycache__`, nginx temp
      dirs). Do them one stack at a time, not in one sweep.
- [ ] **A default healthcheck.** No stack ships one: `docker-build-plan.ts` has
      zero `HEALTHCHECK` occurrences, `StackDefinition` has no health field, and
      the only write site is `deployServiceWorkload` gated entirely on
      operator-authored `advanced.healthcheck` — the compose/service path only.
      The single-app container path cannot express one at all. Laravel ships `/up`
      (configurable in `bootstrap/app.php`), which would make a real healthcheck
      nearly free for that stack.
- [ ] **Bare PHP: the start command, not the toolchain.** *(Item corrected — the
      previous version blamed a missing installer and cited the wrong file.)* The
      real toolchain catalog is `packages/adapters/src/toolchain/catalog.ts` and it
      DOES have `php` and `composer`, with per-distro plans (apt/dnf/yum/apk/brew)
      and a `getcomposer.org` fallback, matching `stacks.ts`'s
      `requiredTools: ["php", "composer"]`. (`system/modules/catalog-embedded.ts`
      is the embedded infra-module catalog and holds only `openresty`.) The actual
      blocker is that laravel and symfony hard-code
      `frankenphp run --config /etc/frankenphp/Caddyfile`, a binary and path that
      exist only in the `dunglas/frankenphp` runtime image — so PHP is docker-only.
      Fine, but the actionable half is still unshipped: **say so when a user picks
      bare** (`packages/adapters/src/runtime/bare.ts` has no PHP handling and no
      refusal message).

---

## Open TODO markers in code

Verified present 2026-08-20; listed so they aren't lost.

- [ ] `apps/api/src/middleware/better-auth-shield.ts` — audit the shield flow
      end-to-end for correctness/security.
- [ ] `apps/api/src/lib/route-permission.ts` — per-route `auditOnRead` flag.
- [ ] `apps/api/src/modules/projects/transfer.service.ts:342-347` — the
      business-logic phase of project transfer: destroy the cloud workspace
      RUNTIME, kick the local deploy pipeline, re-bind the GitHub installation to
      the local org, write the `audit_event` row. Part of the deferred logic HAS
      landed — the promote path tears down the source project — and the file header
      now says so.
- [ ] `apps/api/src/modules/system/migration/migrate-instance.service.ts` —
      trigger the actual deploy once deploy-engine integration lands (see the
      control-plane migration item below).
- [ ] `packages/adapters/src/infra/cloud.ts` — Oblien route + SSL endpoints are
      stubs (`POST /routes`, `DELETE /routes/:domain`, `POST /ssl/provision`,
      `POST /ssl/renew`, `GET /ssl/status`). Cloud is the source of truth for
      managed certs; until these exist, cloud SSL status is not readable.

*(Removed: `active-organization.ts` — the file has no TODO marker and the fallback
decision is made and argued in the block comment at :78-99. And
`cloud-resources.ts` — its stale "resize intentionally disabled" NOTE was deleted
rather than logged, since the resize shipped and is mandatory.)*

---

## Known gaps

Re-verified against the tree 2026-08-20.

- [ ] **Migrate control plane → server**: phases 0+1 shipped, and **sealed
      transfer shipped too** (`sealedRemoteImport()` in
      `system/migration/db-migrate-remote.service.ts`, writing the bundle + a 0600
      env-file over SSH, with `apps/api/scripts/import-instance.ts` as the
      target-side runner). What remains: bare-server SSH provisioning, the deploy
      trigger (step 3 is still a comment), and the unmounted `/migration/probe`
      endpoint. SSE was a deliberate v1 non-goal, not pending work.
- [ ] **Edge loopback-port routing**: shipped and DEFAULT, not "pending
      activation" — `resolveRouteStrategy` (`apps/api/src/lib/upstream-url.ts`)
      returns loopback-port for anything but an explicit `container-ip`, and every
      upstream site routes through it. What's left: real-box E2E (single-app +
      multi-service compose), the commented-out `RoutePreferences` card in
      settings, and the still-live container-IP fallback for routed services.
- [ ] **Static sandbox build**: build ⟂ serve split landed; the #640 lifecycle
      closures are confirmed on disk (doc-root paths classified as an `artifact`
      and destroyed rather than handed to `removeImage`; the compose static path
      promoting into `releases/<dep>-<svc>`; the output audit making one real HTTP
      request through the edge). Still unverified on a real box: the promote+audit
      over an SSH executor, and the docker-edge static serve path — which is a
      shared host bind mount, NOT an `openship_static` volume (the volume survives
      only as a one-time legacy migration in `compose.ts`).
- [ ] **ARM64**: the Linux arm64 AppImage IS built (`release.yml` adds an
      `ubuntu-24.04-arm` matrix entry producing `Openship-arm64.AppImage`, with x64
      keeping the legacy name for auto-update compatibility, and both the updater
      and the CLI installer are arch-aware). What remains: CI verification that the
      arm runner's AppImage actually works, plus **Windows arm64 desktop is not
      built** and `renderAssetName` still defaults `{arch}` → `amd64`.
- [ ] **Cloud compose incremental add**: wired, not live-validated. The decoupled
      add path has no cloud refusal (`services/service.service.ts` calls
      `deployComposeServices` with `strictScope` and resolves resources with
      `isCloud`), and the cloud mesh gap is closed (carried peers are seeded via
      `registerExistingWorkload`). What's missing is running the incremental-add
      mesh rewrite (`/etc/hosts` + private_link) against the real Oblien API.
- [ ] **Unified app settings**: BUILT end to end, not "planned, not started" —
      `apps/api/src/modules/apps/app-settings.routes.ts` mounted in `app.ts`, with
      the generic renderer `apps/dashboard/src/components/app-settings/AppSettingsForm.tsx`.
      What remains: enforce the declared-but-unenforced `required` field gate,
      runtime E2E of the install route, and native i18n review of
      `projectSettings.appInstall` beyond EN.
- [ ] **Device auth for CLI cloud-connect** requires a SaaS redeploy to go live.

*(Removed: the cloud/self-host isolation audit — all five named leaks are fixed
in the tree: the `dump.ts` FK gap plus a same-org `assertDestinationOrg` guard in
the restore orchestrator, MS Teams SSRF via `safeFetch` with no redirects, the
verify-pending sweep, the stale notification subscription, and the GitHub push
fan-out. And the mail DKIM/SES clobber — `stepDkimKeys`'s one runner now re-lays
the relay records immediately after rebuilding `dnsRecords`.)*
