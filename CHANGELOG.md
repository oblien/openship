# Changelog

All notable changes to Openship. Versions follow [semver](https://semver.org);
the in-app updater surfaces critical advisories from `release-advisories.json`.

## 0.4.9

Rollback is rebuilt so it actually restores a release, plus a round of fixes
across the MCP integration and custom domains.

### Rollback

- **Roll back any release, on every project** — the Rollback action used to be
  greyed out on projects using the default settings, because nothing marked their
  releases as restorable. It's now available on every successful release, and it
  is a single action: Openship reuses the release's retained image when it's still
  on the server (seconds, no rebuild) and rebuilds that release's commit when it
  isn't. It can no longer dead-end — the "Redeploy this commit" fallback button is
  gone because the one action already covers it, and the confirmation tells you
  which of the two you're about to get.
- **A restored release comes back complete** — a rollback now runs the same deploy
  pipeline a normal deploy does, replaying that release's own frozen configuration
  and environment variables. Previously it hand-assembled a bare container, which
  meant a "successful" rollback could come back with no environment variables, no
  published port (a 502 behind your domain) and its volumes detached. Restores now
  get the health check, the crash-loop watch, routing, logs and a build log of
  their own, exactly like any other deploy.
- **Compose stacks roll back per service** — only services whose image is missing
  are rebuilt; a service the deploy never touched keeps running on the image it
  already has, so rolling back your app code doesn't bounce your database.
- **Static sites roll back their files** — a static release's artifact is its built
  files on disk, not an image, so restoring one copies that version's files back
  into place (hard-linked, so it costs almost no extra disk) and re-points the edge
  at them. No image, no rebuild. A static rollback previously tried — and failed —
  to restart a directory as if it were a process.
- **Restoring never breaks the release you're on** — a restore reuses its source
  release's image, so two releases can share one. Retention now knows that and will
  not delete an image another retained release still needs.
- **Rollback history sizes itself to the disk** — how many releases stay restorable
  is now measured from free space on the deploy host and your project's real image
  size (a quarter of what's free, between 2 and 20 releases), instead of a fixed 5.
  You can still pin an exact number; clearing the field returns it to automatic.
- **The settings moved next to backups** — rollback retention now lives in the
  project's Backup tab, and in the deploy wizard's target panel where you pick the
  server, with the measured snapshot size and free disk shown inline. Pinning a
  release to keep it restorable indefinitely is unchanged.
- **Set retention while you're still choosing the server** — the wizard's rollback
  controls are editable on a first deploy too, and the choice is applied when the
  project is created. They used to render read-only until the project existed,
  which was the one moment you were actually looking at them. The card also names
  what a retained version *is* on your project — built files for a static site,
  images otherwise — instead of talking about images either way.
- **The wizard's Advanced panel says what's in it** — it listed only the build
  location while hiding the rollback window and clone location; it now names each
  section it contains. The summary chips next to the target (Static, Sandboxed, tier)
  lost their coloured pill backgrounds and read as plain text, with the one that
  matters — an unsandboxed "direct on host" runtime — still called out in colour.
- **Flipping the retention setting applies to existing releases** — it used to be
  frozen onto each deployment as it was created, so turning on instant rollback did
  nothing for anything already deployed.

### Fixes found while rebuilding rollback

- **Older releases could not be deployed or restored at all** — a release whose
  configuration snapshot predated the "production paths" setting crashed the deploy
  pipeline outright. This affected plain redeploys too, not just rollback.
- **A restore is no longer refused for missing build settings** — a release that
  reuses an existing image needs no install or start command, but pre-deploy checks
  demanded them. Adding a required setting would otherwise have made every older
  release un-restorable.
- **Registry-image-only projects can deploy again** — a stack adopted from a Docker
  migration has no git repository and needs none, but deploys were refused for not
  having one.
- **Compose deploys record which service ran which image** — six of the nine places
  that write per-service deployment records left the service name blank, so a later
  rollback couldn't tell services apart and rebuilt the whole stack.
- **A cleared rollback-history field no longer means "keep nothing"** — an empty
  value now falls back to the default instead of purging every restorable release.
- **Docker outside Docker Desktop is reachable** — local deploys honor `DOCKER_HOST`
  (and an explicit socket path) instead of assuming `/var/run/docker.sock`, so
  Colima, Rancher Desktop, Podman and rootless Docker work.

Upgrade note: this release drops an unused `artifact_retained_at` column from the
per-service deployment table. Nothing read or wrote it.

### MCP
- **Guided deploy flows** — the MCP server now ships a prompt catalog
  (`deploy-from-git`, `deploy-a-folder`, `install-catalog-app`, and an
  orientation overview) so an AI client follows the correct tool sequence
  instead of reverse-engineering it from a flat list. Its write tools now carry
  typed request bodies end to end (projects, deployments, domains, webhooks,
  notifications, connections, apps), and every prompt points at
  `github.com/oblien/openship/issues` when a client hits a platform bug.
- **Scoped tokens list the right tools** — a token granted a single GitHub repo
  (or the "create your own projects" scope) now correctly advertises the tools
  it can actually call. Previously the per-repo GitHub tools and the project
  create/list tools were filtered out of `tools/list`, so a scoped token saw
  nothing to work with.

### Custom domains
- **`www` is its own domain, not an attachment to yours** — "Include www" always
  created a second hostname, but the pieces around it still treated the pair as
  one thing. Renewing SSL for a domain issued the `www` certificate inside the
  same operation, unguarded: a `www` that wasn't pointed at the server yet failed
  *after* the apex had already succeeded, and the apex was reported as broken.
  Adding a domain with the switch on also showed you only the apex's DNS record,
  so `www` never resolved, its certificate could never be issued, and every
  deploy retried a hostname that had been set up to fail. Both hostnames now get
  their own DNS record, their own Verify button, their own certificate — and their
  own failure.
- **Redirect one domain to another** — any domain can now answer a 301 (or 302) to
  another domain of the same project, set on the domain's card. `www` uses it by
  default (`www.example.com` → `example.com`), and the direction is yours to flip
  or turn off. Old-domain-to-new-domain moves work the same way. The path and query
  string are preserved, the redirecting host still gets its own certificate, and a
  target outside the project — or a redirect that would loop — is refused.
- **Verify keeps the log when it fails** — the verify modal streamed certbot's
  output and then, on any failure, replaced the whole console with one line:
  "the connection closed before the operation reported a result — check the
  domain's status." The actual reason was discarded. The log now stays on screen in
  every outcome, with Copy log and Try again next to it. And if the connection
  really does drop, Openship reads the domain's state back and tells you what
  happened instead of asking you to go and look.
- **A finished run stops reporting itself as failed** — a keep-alive ping could
  race the final event of any live-log stream (verify, edge setup, deploys) and win,
  so the browser never received the result of an operation the server had already
  completed. Stream writes are serialized now, and a result that has arrived can no
  longer be overwritten by the connection closing behind it.
- **Two domains on one server no longer fight over certificates** — certificate
  issuance is serialized per server, not just per hostname. `www` made two pending
  domains the normal case, and a manual Verify could collide with the background
  retry working on the sibling: both ran certbot, both wanted the same challenge
  port, and one died with an error that read like a DNS problem.
- **The A record shows your server's IP** — on a self-hosted install the
  pre-deploy DNS panel now fills the A record's value with the server's public
  address (detected once when the server is registered) instead of leaving it
  blank.
- **Correct self-hosted DNS guidance** — the panel no longer tells you to add a
  TXT record on a self-hosted box; there isn't one — HTTPS is issued
  automatically on the first deploy. The DNS modal is also lighter and on-theme,
  and the "Include www" switch now sits below the domain field so it no longer
  shifts the input as you type.

## 0.4.7

The CLI self-hosting story is finalized, remote-Docker migrations are made
reliable, and a batch of fixes lands across the control plane for a more stable
release.

### CLI
- **A finished install opens the control panel, not the setup wizard** — bare
  `openship` (and the from-source `openship-dev`) now recognizes a Docker Compose
  install (the default on Linux). Re-running after setup manages the running
  stack instead of walking you through name / email / domain from scratch again.
- **Control-panel Start / Stop / Restart drive the actual stack** — on a compose
  install these now run `docker compose up -d` / `restart` / `down` and read the
  stack's real state, instead of targeting a systemd unit that was never
  installed (which reported "stopped" for a healthy stack).

### Migrations & remote Docker
- **The SSH → Docker bridge no longer hangs or false-fails a healthy server** —
  migrating from another platform (Coolify/Dokploy/Dokku) or adopting a running
  Docker host could stall the reachability check — or drop the request outright —
  under the Bun-hosted API, even against a perfectly healthy daemon. The bridge
  now starts reading the request socket immediately and verifies each forwarded
  channel actually carries data, falling back to `docker system dial-stdio` on a
  fresh connection when a channel opens dead. Contributed by @jbermudez00 (#271).

### Mail
- **Mail-server setup works from the desktop app** — the iRedMail engine is now
  shipped inside the packaged desktop app (and the CLI bundle) and located by an
  explicit path, fixing the `Transfer iRedMail Engine … tar: could not chdir`
  failure on install.

### Fixes
- **Self-hosted GitHub connect is token-first** — a remote (VPS) instance pastes
  an access token inline in the Library, with no `gh auth login` hints; the gh
  CLI path is now desktop-only, where it belongs.
- **The deploy wizard lands on configuration directly** — the deploy-target
  picker no longer flashes on entry. A sensible target is applied silently and
  stays one click away in the summary bar at the top.
- **The control plane stops listing a phantom service** — the self-managed
  "Openship" project no longer shows a bogus public `openship` service (and its
  stray `openship-openship.opsh.io` route) that matched no container and read
  "Stopped" forever.

## 0.4.0

A security fix for the edge, migrations that behave like a native repo project,
and a batch of routing/reliability fixes.

### Security
- **Unrouted HTTPS hosts are rejected, not cross-served** — the edge now owns a
  `443` default server that refuses any hostname it doesn't route (one you
  removed, never added, or merely pointed at the box's IP). Before this, such a
  request fell through to the first-loaded vhost and was served **another app's
  certificate and backend**. Applies automatically on the next deploy, on both the
  bare and containerized edge. Critical — see the in-app advisory.

### Migrations
- **A migrated project is now a native repo project** — a migrated compose stack
  redeploys like any repo project: it reclones and **rebuilds `build:` services**
  and pulls `image:` ones, instead of failing on a frozen build tag (`404 no such
  image`). The running image is reused only **once**, at cutover.
- **The whole compose is the deployment plan** — the migrate screen lists every
  repo compose service, not just running containers, so a service with no
  container (e.g. `redis`, or an app that wasn't up) is built/pulled and routed
  like the rest, with its env and route editable on the card.
- **Reused databases stay reachable** — a reused container is joined to the new
  project's network under its service-name alias, so a freshly-built app resolves
  `postgres:5432` by name, exactly like a native deploy.
- **A migrated service reports the container it really runs as** — service state
  is read live from the host and matched by identity (label → `openship-<slug>-<svc>`
  name → tracked id → compose labels), so a container Openship adopted **in place**
  (its docker labels still name the previous project) no longer shows "Stopped"
  while it serves traffic. Each run's log now ends with the container, state and
  match for every service.

### Fixes
- **Service state is never guessed from the database** — Start/Stop/Restart, logs,
  terminal, backup/restore and volume sizes resolve the container against the host
  first, so a redeploy that replaced it no longer leaves them failing with
  `no such container` — or, on Start, launching a **duplicate** container beside
  the running one. A crash-looping container now reads **Restarting** instead of a
  green "Running", and an unreachable host reads **Unknown** instead of echoing the
  last deploy status.
- **Removing a route never wrongly demands Openship Cloud** — the free-domain gate
  classifies by hostname, so removing a custom-domain route (or any route) is no
  longer blocked by an unrelated free subdomain still in the set.
- **Deleting a service can't hang** — runtime teardown is time-bounded, so a slow
  or unreachable server no longer strands the delete before the record is removed.

<!-- editors: highlights only, trim/adjust before tagging — not rendered on the website -->

## 0.2.4

Native Apple Silicon builds, drop-in compatibility with other platforms' deploy
config, and a batch of self-hosting and reliability fixes.

### Downloads
- **Native Apple Silicon (arm64) desktop app** — macOS now ships separate
  **arm64** and Intel **x64** dmgs (both built and SHA-256-checksummed in CI), so
  Apple Silicon Macs run natively instead of under Rosetta. Windows (x64) and
  Linux (AppImage) are unchanged.

### Deploy · stack detection
- **Deploys repos already configured for another platform, as-is** — the stack
  detector now reads **`railway.toml`/`railway.json`** and **`vercel.json`**
  (build / install / start / output commands, framework, and routing) and folds
  them over its own detection. A repo that already tells Railway or Vercel how to
  build it deploys the same way here, no reconfiguration. Every config source
  runs through one shared parser registry (no per-source special-casing).
- **`openship.json`** — an optional repo-root config to declare build, routing,
  env, and domains up front; it's authoritative over auto-detection and rides the
  same engine, for the repo root and each monorepo sub-app.

### Self-hosting
- **Deploys to your own server by default** — a self-hosted instance targets the
  server it runs on, never Openship Cloud, unless you explicitly choose cloud.
- **Health checks work when the control plane is containerized** — the
  post-deploy probe reaches your app through the host gateway, so a containerized
  self-host no longer fail-reverts an otherwise-healthy deploy.
- **OpenResty installs on newer distros** — the edge install no longer pins the
  APT repo to a codename that doesn't exist yet (e.g. Ubuntu 26.04), and self-heals
  a box already broken by the old pin.

### CLI
- **`openship stop` actually stops** — the service and its children are reaped by
  process group and any ports it held are swept, so a restart can't strand the
  old process on a new port.

### Reliability & fixes
- Malformed JSON request bodies now return **400**, not 500.
- **Cloud static-output path is confined** — the Pages output path resolves
  through one shared, sandboxed resolver so a build can't escape its output dir.
- Mail DNS scan **detects duplicate DMARC records**.
- OAuth discovery metadata is served correctly **behind a public URL**.
- SSH exec streams **close cleanly on timeout** instead of leaking.
- Bumped the Laravel deploy **test fixture** off a vulnerable `laravel/framework`
  (CRLF email advisory) — a fixture only, never a shipped dependency.

<!-- editors: highlights only, trim/adjust before tagging — not rendered on the website -->

## 0.2.2

Apps and Jobs grow up, a self-hosted server can now talk to GitHub on its own,
Backups get a real home, and a batch of delete/login/database reliability fixes.

### Apps
- **Day-2 app settings** — installed apps now expose a curated settings surface
  (schema-driven) so you can change an app's real config after install without
  digging through raw env. Edits go through a safe env-merge and tell you whether
  a full redeploy (vs a quick restart-apply) is needed.
- **Clean per-app install wizard** — clicking a catalog app opens a focused,
  business-only setup that creates the project on confirm; the technical deploy
  wizard is now the "Advanced" path (no more orphaned draft projects from a
  half-finished install).
- **Openship Mail is a first-class app** — it appears in the catalog alongside
  Convex and n8n and hands off to the mail wizard. The rest of the catalog shows
  as **Coming soon** (dimmed, not installable) for this release.

### Jobs
- **Automated backups show up in Jobs** (read-only) — backup schedules run on the
  same job runner as everything else (zero duplication), so their next/last run
  sits right next to your system and custom jobs.

### Servers · GitHub
- **Connect GitHub on a server** — each self-hosted server now authenticates to
  GitHub on its own, from a dedicated **GitHub** tab: sign in with a device code
  (like `gh`), paste a token, generate an SSH key to add to your account, or use
  auto-registered read-only per-repo **deploy keys**. Credentials are stored
  encrypted and the exact same connect panel is reused inside the deploy flow, so
  a missing credential is one click to fix mid-deploy. Private-repo clones now
  work without your desktop online.

### Backups
- **Redesigned Backups** — per-destination storage stats, a sticky status rail,
  and clickable rows that open a per-destination detail page showing exactly which
  projects and services back up there.

### Cloud
- **Per-user project cap** — Openship Cloud enforces a hard cap on projects per
  user (env `CLOUD_MAX_PROJECTS_PER_USER`, default 2), at both create and
  folder-upload/ensure. Self-hosted is unmetered.

### Reliability & polish
- **Deletes never get stuck** — project deletion shows a real **Deleting** state,
  and when the source teardown can't complete you get a clean **"Delete from
  storage"** option that drops the record immediately (leftover resources are
  reclaimed later by GC). The atomic, all-or-nothing delete stays the default.
- **Desktop sign-in fix** — the login redirect now lands on the same loopback host
  the session cookie was minted on (`localhost` ⇄ `127.0.0.1`), so the dashboard
  no longer opens cookieless and bounces you back to `/login`.
- **Embedded database start-up** — no more false "locked by a different machine"
  on your own box when the machine-id probe is momentarily flaky; the cross-machine
  guard now only fires on a genuinely different, stable machine id.
- **Calmer, consistent theming** — status colors (success / warning / danger /
  info) are unified semantic tokens across the whole dashboard, and the dim
  theme's greens and reds are tuned for comfortable contrast.
- Servers empty state refreshed — clearer illustration, a **See docs** action, and
  a distinct icon per "what gets configured" tile.

## 0.2.0

A large feature + hardening release across the deploy flow, the app catalog,
routing, servers, jobs, and the build toolchain.

### Deploy
- Redesigned **"Where do you want to deploy?"** step: unified page-style header
  with the **Continue** action aligned to the config column, and a **collapsed,
  searchable server picker** (with an inline "Add your own server").
- **Package-manager toolchain fix** — pnpm/yarn are now enabled via `corepack`
  across every build path (cloud, generated Dockerfile, bare host, monorepo
  workspace-prepare, cloud local-build). Fixes `pnpm: not found` on deploy.

### Apps
- **Searchable, category-tabbed one-click app catalog**, expanded to 15
  production-ready self-hosted apps: Convex, n8n, Ghost, Directus, NocoDB,
  Metabase, Grafana, Gitea, code-server, Uptime Kuma, Vaultwarden, FreshRSS,
  Stirling PDF, IT-Tools, Excalidraw.
- Home "Apps" card refreshed; catalog cards show real brand logos.

### Routing & domains (single source of truth)
- Custom domains on **service-based projects** now flow through the same
  verify → DNS-records → SSL pipe as single-app domains: a verifiable pending
  row is minted on add/create/edit, one canonical hostname normalizer is shared
  across storage/routing/domain-service, lookups are cross-tenant-safe, and
  certbot is gated on verification (no wasted Let's Encrypt attempts).

### Servers
- Redesigned servers page (tabs, live reachability, country flags).
- Per-server **Git** auth tab (token / SSH key / deploy keys) with a
  comfortable full-width card; connect-on-server credentials honored in preflight.

### Jobs
- Jobs page gains **search** + an at-a-glance **status filter sidebar**
  (running / failed / scheduled / disabled), shown once custom jobs exist.

### Team & workspace
- **Invite member** is only offered where it works (team orgs on a multi-user
  instance); single-user/personal instances are guided to migrate or create a
  team org instead of hitting a dead end.

### Add service
- The **Openship Cloud** image tab shows a "Connect to Openship Cloud" CTA when
  the instance isn't linked, and the source switcher has clearer contrast.

### Other
- Docker migration flow, per-project/service backups, unified connectivity
  checks, Arabic (RTL) localization, marketing roadmap page, and desktop window
  polish (macOS traffic-light inset).

<!-- editors: highlights only, trim/adjust before tagging — not rendered on the website -->
