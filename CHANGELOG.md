# Changelog

All notable changes to Openship. Versions follow [semver](https://semver.org);
the in-app updater surfaces critical advisories from `release-advisories.json`.

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
