# Changelog

All notable changes to Openship. Versions follow [semver](https://semver.org);
the in-app updater surfaces critical advisories from `release-advisories.json`.

## Unreleased

### Maintenance

- **The built-image garbage collector is inspectable and runnable by hand** —
  `openship system image-gc --dry-run` lists every project's build images on its
  deploy host with the decision the `images:gc` sweep would take and why (active,
  pinned, inside the rollback window, in use, operator-retagged, or superseded),
  the rollback window that decided it, the job's schedule and last run, and the
  space a run would reclaim. Without `--dry-run` it confirms and runs the sweep,
  recorded as a manual `images:gc` job run. `--older-than 30d` narrows a run to
  superseded images at least that old; age never overrides the keep-set. Backed
  by `GET /api/system/image-gc/plan` and `POST /api/system/image-gc/run`
  (instance admin). `openship system runtime-images` lists the previous
  `openship-api` / `openship-dashboard` / `openship-edge` images an update leaves
  on the host and, with `--prune`, removes all but the referenced version and
  `--keep` previous ones (#779).

## 0.6.10

This release hardens the full deployment lifecycle, makes Compose reconciliation
lossless, completes remote-server setup and CLI targeting, fixes external mail
health and administration, and ships the invitation, DNS, catalog-routing, and
update-experience work accumulated since 0.6.9.

### Source control

- **Self-hosted workspaces can own and manage multiple GitHub Apps** — Settings → Git now supports
  one-click GitHub.com manifest creation and manual GitHub/GitHub Enterprise Server registration,
  without an Openship Cloud or OAuth dependency. Private keys, client secrets, and webhook secrets
  are encrypted at rest; source-specific JWTs mint short-lived repository-scoped tokens against the
  correct API origin; GitHub sends verified lifecycle, push, and check webhooks directly to the
  instance. Owners can install an App on multiple accounts, rotate and verify credentials, select a
  default source, and safely delete one while project bindings move to an available replacement.
  Existing environment-backed Apps, `gh`, personal tokens, and per-server SSH keys remain compatible
  fallbacks (#782).
- **GitHub App installation is tenant-safe end to end** — install callbacks bind a durable one-shot
  nonce to the initiating user and workspace and verify the reported installation against the
  configured App before atomically persisting and reconciling it. The cloud callback survives API
  replicas/restarts, rejects removed workspace members, and cannot bind another tenant's
  caller-supplied installation id. Installation rows, token caches, project bindings, lifecycle
  webhooks, and reconnects are workspace-scoped; webhook arrival order never guesses a workspace
  from membership order (#759).

### Accounts and teams

- **Self-hosted organization invitations now work for brand-new users** — the
  claim page loads safely before sign-in, routes existing users back after
  login, offers token-bound account creation only when authorized, and exposes
  a copyable link beside each pending invitation. Invitation authorization,
  identity, credential, personal workspace, and membership now commit under one
  locked transaction, so cancellation races and failed signup cannot leave an
  unauthorized or partial account that blocks retry. Accept, reject, cancel,
  and signup mutations are serialized per invitation across API replicas. API
  access logs and Edge request telemetry also redact invitation bearer tokens
  and discard query strings before storage (#743).

### DNS

- **Service custom domains use the explicit DNS plan/apply workflow** — saving
  a service route creates the same pending domain row as every other custom
  domain, then the shared records panel previews provider changes and applies
  them only when requested. The API documentation no longer promises a silent
  provider write that the product deliberately does not perform (#760).

### Server setup

- **Remote servers always require Docker before Edge** — server readiness no
  longer inherits the control plane's `DEPLOY_MODE`. Docker and Git are checked
  for every managed target, while one shared dependency planner inserts and
  orders Docker ahead of the container-based Edge across streamed setup,
  `SystemManager`, and direct component installation guards (#767).

### Builds

- **BuildKit builds work from Bun-based self-hosted installations** — Docker's
  reverse h2c session now bypasses Bun's incompatible `node:http` upgrade path
  while retaining dockerode's BuildKit session and registry-auth service. Local
  Compose builds using syntax directives, cache mounts, heredocs, and other
  BuildKit-only Dockerfile features no longer fail on `/session` before the
  Dockerfile starts (#745).

### Updates

- **Update prompts show the product changelog** — dashboard and desktop update
  surfaces now read the matching version from the tagged `CHANGELOG.md` instead
  of repeating the GitHub Release body. The native update panel keeps advisory
  copy separate from a resizable, scrollable changelog, and all changelog actions
  open the version page on `openship.io` rather than GitHub (#752).

### Catalog apps

- **Port-only app endpoints are actually published** — an explicit port-only
  choice now persists a fixed all-interface Docker binding, including for
  catalog routes such as Supabase Kong that declare a served port but no Compose
  `ports` entry. This makes the wizard's server URL and `{{publicUrl:…}}`
  substitutions truthful. Retrying a failed draft reconciles the binding
  idempotently, and switching to a domain removes or restores only the mapping
  owned by the installer (#770).

### Mail delivery

- **Mail setup now proves public reachability before declaring success** — the
  final setup step combines the target's listener table with bounded off-box TCP
  checks for 25, 465, 587 and 993. The Health tab shows each port as a first-class
  signal, reusing a coalesced 60-second sweep, and test-email timeouts now identify
  provider firewalls/security groups/security lists/NSGs instead of blaming a
  stopped SMTP daemon when Postfix is demonstrably listening (#755).
- **Mail health no longer treats fake-IP IPv6 answers as broken DNS** — synthetic
  ULA AAAA responses from Clash/sing-box are now `unknown`, matching the existing
  A-record behavior. Together with the informational SpamAssassin row and
  normalized split-string DKIM comparison, this closes all three false-positive
  paths reported in #240.
- **Relayed webmail keeps the correct split-delivery path** — webmail continues to
  submit to the local Postfix on 465, which alone owns relay scope, DKIM signing,
  and provider credentials. The identical timeout reported in #391 now receives
  the shared public-port diagnosis; provider relay credentials are never copied
  into the webmail container.
- **The platform sender now self-heals instead of getting stuck on SMTP 535** —
  cached `openship@<domain>` credentials are reused only while the live mailbox
  and forwarding rows remain active. A deleted row is recreated automatically,
  and an already-cached transporter rotates once and retries safely on an auth
  rejection (#754).
- **The platform mailbox is protected and repairable** — ordinary mailbox edit
  and delete operations reject the Openship-owned sender, while the Mailboxes
  tab exposes a dedicated password rotation/repair action that also works when
  the row is missing.
- **Mail configuration works with non-root SSH users** — relay maps and
  additional-domain DKIM configuration now elevate only root-owned host-file
  operations while Docker commands keep the login user's daemon context. Relay
  credentials are published atomically as `0600`, and a server without root or
  passwordless sudo receives an actionable typed refusal unless the mail bind
  mount was explicitly made writable for that login (#756).

### Deployment cancellation

- **Cancelling after an image build now stops the whole deployment worker** —
  cancellation propagates through post-build preflight, human prompts,
  host-scoped provisioning locks, activation, health checks, routing, and both
  single-service and Compose pipelines. A durable database signal also wakes a
  worker running in another API process.
- **Redeploy waits for real worker completion** — a cancelled row keeps its
  execution lease until cleanup has finished, while the dashboard shows the
  cancellation still stopping instead of offering a redeploy that cannot safely
  start. The API and CLI report success only after that lease is released;
  otherwise cancellation remains explicitly pending. Refreshing reattaches to
  that server-backed state (#757).
- **Cancellation cannot replace or tear down the live release** — the cancelled
  transition is conditional and atomic, and cleanup excludes containers carried
  forward from the active Compose release. If ownership cannot be proven,
  cleanup fails closed.

### Compose reconciliation

- **Repository edits cannot silently erase service environment variables** —
  removing one or more environment keys from Compose now preserves the running
  service configuration and creates an explicit drift review, even when the
  operator never edited the imported baseline. Accepting that review remains
  the deliberate way to apply the deletion.
- **Local-path Compose projects materialize their services automatically** —
  `project create --local-path ... --type services` now uses the API's canonical
  scanner and persists the detected rows immediately. Deploy and redeploy also
  re-read the same local source through the existing three-way reconciler, so a
  legacy zero-row project self-repairs instead of entering an empty services
  pipeline (#751).
- **Compose env expressions have one sync/deploy meaning** — raw manual syncs
  preserve `${VAR}` provenance and resolve it from the final project/service
  environment at deploy time, while Docker Compose-normalized CLI syncs carry an
  explicit final-value marker so escaped `$$` is never expanded twice (#751).
- **Terminal failures survive refresh** — the deployment lifecycle writes one
  deduplicated terminal error into the durable build log for every lifecycle
  failure path, including an empty Compose service set, instead of leaving the
  explanation only in `deployment.error_message` (#751).

### CLI

- **New projects and deploys can target a registered SSH server** —
  `project create --server <id>` stores the initial binding, while
  `deploy --server <id>` drives Git and folder uploads through the same
  org-scoped target resolver and deployment preflight as the dashboard. The
  deployment response exposes a stable id for `--watch`, `project get` shows the
  resolved target, and a failed deploy never retargets the project (#763).

## 0.6.9

This critical deployment-safety hotfix makes legacy Docker Compose ownership and
routing fail closed. Existing unmanaged stacks can no longer be mistaken for an
Openship deployment or silently duplicated, and an ordinary same-server
redeploy cannot move a routed service onto a different host port.

### Deployments and routing

- **Existing Compose stacks are never adopted implicitly** — before changing
  containers or routes, a normal deployment checks the target for an untracked
  Docker Compose stack with the same project slug and service names. A collision
  now stops with `FOREIGN_COMPOSE_STACK` and tells the operator to import/adopt,
  remove, or rename it. Explicitly adopted containers and containers already
  tracked by Openship continue normally.
- **Same-server host ports stay locked across redeploys** — a routed service
  keeps its active host port on its current physical server. If that port cannot
  be reclaimed safely, deployment stops before routing changes instead of
  allocating a new port and leaving the public hostname pointed at the wrong
  workload. A real server migration may still allocate a new host port.
- **Duplicate-container warnings require ownership evidence** — normal projects
  no longer claim same-slug containers through Docker Compose labels alone.
  Native Openship labels, the canonical managed name, or the tracked container
  id establish ownership; Compose-label recovery remains available only for an
  explicit adoption.

### Compose reconciliation

- **Legacy parser metadata does not create false repository drift** — adding
  environment/build-argument template provenance to an older service baseline
  is treated as a one-time metadata upgrade, not as a Compose edit. Real changes
  arriving with that metadata are still reported, and operator-edited live
  values remain intact while the baseline advances.

### Monitoring

- **Issues is now the Monitoring workspace** — the dashboard adds a Health view
  for every tracked project service, with fleet counts and state charts for
  healthy, unhealthy, crash-looping, down, and unknown workloads. Rows show the
  serving server and last observation, and link back to the service that owns the
  container.
- **Health reads reuse the existing watcher** — the page reads an in-memory
  snapshot produced by the grouped health sweep and Docker-event accelerator; it
  does not create a poller per container or perform Docker I/O on page refresh.
  Per-service monitoring can be disabled before the workload enters the watch,
  inspection, event, or notification path.
- **Fleet updates and rescans continue in the background** — bulk component
  updates start together without holding a modal open, retain their durable
  sessions across navigation and refresh, and allow an operator to reattach to a
  specific log. The checker batch similarly exposes one shared progress session
  so multiple tabs cannot multiply Git, DNS, Docker, or version scans.

> **Upgrade priority: critical for legacy or externally created Compose
> workloads.** Fully tracked Openship deployments are not expected to hit the
> collision path, but installations that previously deployed a same-slug stack
> outside the current control-plane records should upgrade before redeploying it.

## 0.6.8

Compose projects now deploy as the services they declare, with their build
arguments and dynamic environment intact from import through rollback. Instance
moves can go directly from one self-hosted installation to another without
copying an encryption key, and the file workflow shows and filters what it will
carry. This release also hardens custom-domain ownership, host-port allocation,
Git credential boundaries, and edge recovery across Linux and macOS.

### Instance transfer

- **Move an instance directly, credentials included** — the destination creates a
  single-use, ten-minute receive code for Replace or Merge mode; the source
  encrypts the selected database rows and plaintext credential bundle directly
  to that destination, and the destination immediately re-encrypts every
  transferred secret under its own instance key.
  Server SSH passwords and keys, environment variables, tokens, registry and DNS
  credentials, and backup credentials move without sharing either instance's
  `BETTER_AUTH_SECRET` or managing a transfer passphrase (#656).
- **See and filter the export before downloading it** — Settings now shows the
  durable row count and a count beside each optional history group. Analytics,
  audit/notification activity, backup history, incident history, and migration
  history can be included independently; configuration, projects, services,
  servers, users, and credential records always stay in the portable core.
  Leaving the selection absent preserves the legacy full export (#656).
- **Credential-bearing files cannot be imported half-unlocked** — the offline
  export/import path remains available, but a file containing a sealed credential
  bundle now requires its passphrase before any database write. Invalid bundles
  are rejected before restore rather than importing rows whose secrets were
  silently scrubbed.

### Compose and environments

- **Compose services drive their own builds** — a project with `composePath` is
  materialized into the service pipeline instead of falling through to one
  generic Dockerfile build. Map and list forms of `build.args`, bare arguments,
  and `${...}` expressions are stored per service and survive CLI sync,
  reconciliation, migration adoption, redeploy snapshots, and rollback. Docker
  socket, SSH, batch, and cloud builds all use the same argument resolver, and
  Openship's build-command logging does not print argument values (#689).
- **Removing Compose build arguments removes the stored arguments** — an empty
  `args` map or a deleted `args` key clears stale values and interpolation
  provenance, while snapshots created before build arguments existed remain
  non-destructive during rollback (#689).
- **Unsupported Compose builds fail before deployment** — malformed arguments,
  repository-escaping or remote contexts, and build features Openship cannot
  reproduce no longer leave the old service shape running silently. A declared
  Compose project with no materialized rows is scanned once to bootstrap its
  topology, while an explicit single-app choice remains single-app.
- **Dynamic Compose environment resolves at deploy time** — raw expressions such
  as
  `postgresql://user:${POSTGRES_PASSWORD:?set it}@postgres:5432/app` are evaluated
  against the final project, frozen-release, inline, and service-scoped layers.
  Embedded requirements, passthrough keys, defaults, nested expressions, and
  escaped dollars retain Compose semantics; an unresolved required variable
  fails that service with the missing key named (#673).
- **Manual service variables are durable overrides** — the service Environment
  tab now owns service-scoped environment rows rather than rewriting the
  Compose-owned `service.environment` object. Values added in the UI therefore
  survive a Compose reparse and project redeploy. Saving an unrevealed secret —
  including renaming its key — preserves its existing ciphertext instead of
  storing the mask or deleting the value.

### Deployments and routing

- **Prebuilt container images can be tracked as releases** — a single-app
  project can resolve versions from GitHub Releases or an HTTPS version feed,
  optionally pin a version, and render that tag into a registry image template.
  Deploy and Update pull the application image directly on Docker or Cloud — no
  Git clone, Dockerfile build, or release archive — while drift detection compares
  deployed and upstream semver. Successful Docker releases freeze the immutable
  registry digest so rollback can reacquire the exact image after local retention
  expires; source changes apply atomically across environments and are available
  in both the dashboard Source tab and `openship project release-image` (#694).
- **Apply really means restart without rebuild for a single app** — Docker and
  host-mode projects reuse the active deployment's retained artifact even though
  they have no service rows. Apply never fetches Git or silently turns into a
  rebuild; if the artifact is gone, it says to Redeploy instead (#674).
- **The DNS checkpoint covers Docker and every Compose route** — pressing Deploy
  now shows records for single-app custom domains, service scalar routes, and
  multi-route Compose endpoints. Multiple hostnames appear together, `www` is
  grouped with its apex, and a remote deployment preview uses the selected
  server's public address rather than this instance's address (#663).
- **Redeploy cannot detach a custom domain** — deployment reconciliation preserves
  both pending and verified custom-domain rows and their live targets when a
  release omits them. A failed deployment rolls back only generated managed
  routes, never user-owned custom configuration, and concurrent hostname claims
  use database-authoritative ownership instead of letting the losing project
  route another project's domain (#675).
- **Stopped containers cannot turn an old hostname into another app** — loopback
  ports now have database-enforced, physical-target-wide ownership across
  organizations. Allocation reserves the port before Docker binds it, treats
  local and “This Server” as one namespace, and persists every routed Compose
  port through stopped and reconciling states. A stale vhost/TLS certificate can
  therefore never be repointed accidentally when a later deployment starts
  listening on the same number (#682, GHSA-284v-9jw3-jfhx).
- **Retry routing repairs the edge first** — when `openship-edge` is stopped or
  missing, Retry Routing reconciles and health-checks it before touching vhosts.
  An unrecoverable edge returns an actionable warning immediately instead of
  hanging until the route request times out (#693).
- **Project deletion no longer deadlocks on a bare OpenResty listener** — route
  cleanup validates the installed configuration and signals only the verified
  running master instead of starting a second nginx process on ports 80/443.
  Listener checks account for every socket owner, including mixed
  `SO_REUSEPORT` listeners, and fail closed when ownership cannot be proven.
  Delete flags now work consistently in query strings and JSON bodies;
  `forceOrphan` records unfinished host cleanup durably before removing the
  project so the garbage collector can retry it safely (#700).

### Hosts and edge

- **Docker source acquisition follows the actual transport** — preflight and the
  build pipeline now share one source-location plan. Local socket and TCP daemon
  builds prepare source on the API host, remote SSH Docker builds may clone on
  the target, and bare or cloud builds retain their own boundaries. A local
  server row therefore no longer asks a nonexistent remote clone path to use
  ambient Git credentials (#654).
- **macOS edge mounts use physical host paths** — bind sources are canonicalized
  on the machine that owns the Docker daemon, so `/var` and `/etc` resolve to
  their `/private/...` targets before Docker Desktop or OrbStack sees them. A
  healthy-looking edge with stale logical mounts is recreated onto the same
  vhost, certificate, ACME, and static-data directories (#692).

### Security

- **An explicit GitHub CLI config directory is an isolation boundary** — fallback
  token discovery reads exactly the `hosts.yml` selected by GitHub CLI precedence
  on Linux, macOS, and Windows. If `GH_CONFIG_DIR` or `XDG_CONFIG_HOME` is set but
  missing or tokenless, Openship no longer falls through to another user's home
  directory and borrows that credential (#687).

### Openship Mail

- **Inbound SMTP has DNS inside Postfix's chroot** — every mail-engine boot now
  refreshes `resolv.conf` and the supporting NSS files inside the persistent
  Postfix spool before the supervisor starts. The engine fails closed if no
  resolver can be installed, rather than starting an SMTP service that rejects
  every legitimate sender with `450 Helo Host not found` (#686).

### Dashboard

- **Project environments update without a refresh** — creating an environment
  commits it to shared state immediately and reconciles the canonical list;
  deleting one removes it from every affected cache and navigates to the best
  surviving sibling. A failed follow-up read no longer makes a successful create
  look like it failed (#657).

## 0.6.6

Mail learns to receive, and third-party secrets get one home. Openship Mail now
captures, filters and reads inbound messages, and an arriving message can raise a
notification. Alongside it, a single org-scoped credential store replaces the
one-off DNS token table and unlocks private image pulls on any host. The app
catalog is installable end to end, the audit log moves out of Settings onto its
own page, and uploads stop failing at 1 MB.

### Security

- **Job writes are authorized against the job's own target servers** — jobs are
  instance-wide, so the `job:write` permission (which checks organization
  membership) is not by itself authority over the servers a command job runs on.
  Editing and deleting a job now go through the same per-target server check that
  creating and running one already did, and a denial is indistinguishable from a
  job that doesn't exist. Reported externally; regression tests added.
  Self-hosted instances with more than one trust level should upgrade; Openship
  Cloud was never affected (the Jobs API is `localOnly`).

### Credentials

- **One store for third-party secrets** — a provider registry (container
  registries, Cloudflare, and room for what comes next) behind one table, with
  every secret sealed in a single `enc1:` envelope rather than a column per field.
  A credential is verified against its provider _before_ it is stored, so a bad
  token is rejected where you paste it instead of where a deploy needs it.
- **Private images pull on every host** — registry auth is resolved per image from
  that store (#581). On a remote host the config goes to a temporary
  `DOCKER_CONFIG` directory (`0700`, file `0600`) removed whether the pull
  succeeds or fails, so a pull never edits the operator's own
  `~/.docker/config.json`. Local pulls still go through the daemon's own
  credential store, which is what keeps a Docker Desktop `credsStore` working.
- **DNS credentials fold into it** — existing Cloudflare tokens are re-wrapped at
  boot. A token that cannot be decrypted (a rotated `BETTER_AUTH_SECRET`) is left
  exactly where it is, and the legacy row is deleted only once the new one exists
  — a crash mid-move leaves a duplicate, never zero credentials.
- **Git credentials get their own tab** — clone credentials were filed under API
  tokens, which is neither where you look for them nor somewhere a second Git
  provider could go. "API tokens" now means only that.

### Inbound mail

- **A mailbox can be read** — inbound capture, read and watch, so mail that
  arrives is stored and retrievable rather than merely delivered.
- **Inbound filtering fails closed** — loop guards, a spam gate, and scope
  matching that drops a message it cannot confidently attribute instead of
  guessing an owner for it.
- **`mail.inbound_received` is a notification** — inbound mail can drive a
  channel, in a mail group that appears only on self-hosted instances.

### Openship Mail

- **Mailbox creation runs in the engine, not on the host** — `doveadm` and `chown`
  ran on the host, where they don't exist, so creating a mailbox returned a 500
  (GH-562).
- **The database bootstrap fails loudly** — the script had no `set -e`, so a failed
  step still reported success and left a half-provisioned engine looking healthy
  (GH-562).
- **The mail screens look like the product** — the channel picker is now the same
  component the notification and job screens use, with real brand marks in place
  of a native checkbox that renders in the browser's colours rather than the
  theme's, and the admin tabs drop the borders and status dots that matched no
  pattern here.

### App catalog

- **Every app installs** — each catalog app now ships a UI and a connection,
  rather than installing into something you couldn't open.
- **`verified` means upstream-published** — the badge is reserved for bundles
  published upstream, so it stops implying a review it never represented. Neon is
  no longer marked verified (neond is a community control plane), and the
  experimental badge is off both Neon and PostHog.
- **Neon survives real install timing** — its bootstrap assumed a readiness it
  never waited for.

### Migration

- **A selection resolves by identity, not by name** — the wizard sent names and the
  server matched on them (#584), so two containers sharing a name collapsed into
  one pick, and a name matching something outside the selection could be adopted.
  A selection now carries container ids, falling back to names only for a service
  that has none.
- **Openship's own stack is excluded, not a blocker** — the containers running
  Openship are skipped with the reason named, instead of the whole migration
  refusing to start.
- **Two fixes to what a vhost scan imports** — nginx's own default vhost is skipped
  rather than adopted as a site, and prefix-relative document roots resolve
  against their prefix.

### Edge

- **Uploads default to 50 MB** — nginx's built-in limit is 1 MB, and a project
  that never opened the proxy panel inherited it, so any real upload died with a
  413 the app never saw. `client_max_body_size 50m` now ships at `http` scope in
  every edge config, which leaves a project's own value winning wherever one is
  set. Hosts installed before this are healed in place, and a value an operator
  tuned themselves is never overwritten.

### Audit log

- **Its own page** — nothing on it is a setting: you never change anything there,
  you read what already happened. It sat three clicks inside Settings, which is
  how a review surface goes unread.
- **Every filter is in the URL** — filters and pagination are query parameters, so
  a view can be linked, shared and reloaded.
- **The uncatalogued events are catalogued** — events emitted without a taxonomy
  entry now have one.

### Fixes

- **`openship reset-admin-password` works on a Compose install** — it
  authenticated with `~/.openship/internal-token`, a file the Compose path never
  writes: the api container is booted with the `INTERNAL_TOKEN` from
  `~/.openship/compose/.env`. So on a Compose box the command _minted_ a brand-new
  random token, sent that, and reported `Unauthorized` — the lockout-recovery
  command was unusable on exactly the install that needed it. Which token this box
  is running with is now resolved in one place, readers never mint, and a
  root-owned `.env` this user can't open says so (re-run with sudo) instead of
  reporting an authorization failure. Same fix reaches the control panel's "Reset
  admin password", `openship doctor` (whose health readout came back empty on
  every Compose stack), and a bare box's `:80/:443` takeover, which looked for the
  Compose token and skipped importing the migrated sites after stopping the
  operator's proxy.
- **A password reset uses a 6-digit code** — rather than an emailed link.
- **A cancelled deployment keeps its reason** — the failure message was gated on
  `failed` alone, which blanked the reason on every cancelled row. But a cancel is
  not always your Stop: the boot sweep cancels with "Interrupted by a server
  restart", and a superseded partial failure records why. With the reason
  discarded, the install wizard had only its generic "Install failed" left to
  print over a row that said `cancelled`.
- **An install's verdict and its reason agree** — the wizard decided "was this a
  cancel?" and "what do I show?" independently, so a stopped install could print
  "Install failed" underneath the heading "Install cancelled".
- **Verify appears only once a domain row exists** — the optimistic row fell back
  to the bare hostname as its id, and every guard downstream reads that id as
  proof the server row exists. So a hostname with no row yet rendered a live
  Verify button that 404'd, along with a DNS-records panel that couldn't load.
- **An abbreviated commit is not a new commit** — `POST /deployments` takes
  `commitSha` as whatever the caller sends (`openship deploy --commit 1eeaf76`, the
  MCP deploy tool, a CI script), and git checks an abbreviation out happily: the
  right code shipped while the row recorded a name no comparison could match. The
  drift check compared it against the 40-char branch HEAD, and since both sides
  render seven characters, the project page advertised "New commit available
  1eeaf76 … you're deployed on 1eeaf76" — permanently, with a Redeploy that could
  never clear it. Two shas now name the same commit when one is a prefix of the
  other at git's own abbreviation floor, a ref that is not a sha at all (a tag,
  `HEAD`) reads as "can't tell" rather than as drift, and a caller's ref is
  resolved to the full sha before anything stores or compares it — which also
  unbreaks the per-service commit checks GitHub rejects a short sha for, and the
  webhook's already-deploying dedupe.

## 0.6.5

A hardening and reach release. Reported security issues are fixed (see Security
below), the container→host control channel is provisioned and diagnosed end to end
instead of failing quietly, and Openship now installs on any mainstream Linux — and on hosts
where you don't log in as root. It also adds `openship edge` (the whole reverse
proxy from the terminal), real resource limits that respect the machine you own,
an Openship Mail product shell with split outbound delivery, webmail rebuilt as an
ordinary catalog app, and five new one-click apps.

### Security

- **Security fixes** — this release resolves a number of reported security issues,
  with regression tests added for each. Areas touched: authorization on
  instance-wide and GitHub operations, access-token minting, path handling,
  the mail engine, webmail's HTML sanitizer, the desktop shell, and redaction in
  stored build output. Details are published as advisories on the repository.
  **Upgrading is recommended.**
- **Hardening** — host-control operations are pinned to the host channel rather
  than defaulting to the API process's own container, cloud builds can never run
  on the API host, and stored SSH key material is encrypted at rest and stripped
  from any cross-host export.

### The host control channel

- **`openship up` provisions the container→host channel, and tells you when it
  can't** — when Openship runs in Docker, a handful of operations are genuinely
  host-level (freeing a foreign proxy off `:80`/`:443`, host system config, the
  mail engine, writing a catalog app's generated config), and they reach the host
  over SSH on the internal bridge. Install now generates the key, appends a
  restricted `from=`-pinned `authorized_keys` line, checks that sshd listens on an
  address containers can reach, opens the port in whichever firewall the host
  runs, and verifies the round trip — instead of reporting success and failing on
  the first host operation weeks later.
- **It probes every layer, because the failure looks like nothing** — this
  address is host-local, so it traverses `filter/INPUT` where a default-deny `ufw`
  lives; published container ports are DNAT'd and skip it, which is exactly why
  the rest of the stack looks healthy while this one channel hangs. Firewall,
  sshd listen address, key, and reachability are each probed and reported
  separately.
- **One explanation, five surfaces** — the CLI preflight, the API's boot banner,
  `openship doctor`, the dashboard's server banner, and the deploy log a host
  operation dies in had drifted into different stories. They now read from one
  shared vocabulary, because every line is either "your install is fine, this one
  feature isn't" or "your install is broken" — and an operator who reads the
  wrong one either tears down a working box or ignores a dead feature for months.
- **`openship update` repairs an unprovisioned channel** — an install from before
  this work, or a raw `docker compose` install, can be fixed in place by updating,
  rather than re-running `up` and risking the environment. A deploy that needs the
  channel emits the notice once per deploy, before the fan-out, instead of once
  per service.
- **The channel must be root, and says so** — an operation that needs a
  root-owned path fails with the actual cause instead of
  `mkdir: cannot create directory '/root': Permission denied`.
- **Documented for hand-rolled installs** — `.env.example` spells out all five
  steps (key, restricted authorized_keys line, sshd listen address, firewall
  rule, recreate the api because `env_file:` is read at container creation), and a
  new [troubleshooting page](https://openship.io/docs/troubleshooting/host-channel)
  walks the repair.

### Any Linux, and hosts that aren't root

- **Openship installs on the distros it always claimed to** — Docker installation
  was `curl get.docker.com | sh` on every Linux, a script that hard-refuses
  Amazon Linux, AlmaLinux, Oracle Linux and Alpine. Each call site had its own
  package-manager table (there were five, and they disagreed), its own systemd
  test, and its own reading of "host outside my allowlist" — always "nothing to
  do". Host facts now come from one detector, the commands that act on them live
  in one module, and adding a distro is a compile error rather than a silent
  no-op.
- **A working Docker engine is never replaced implicitly** — only an explicit
  reinstall overrides an engine that's already running, and an installer that
  skips an already-working component says so instead of leaving the one
  actionable line nowhere at all.
- **Deploying as a non-root user works** — three layers answered "may I do
  root-owned work here?" differently: component installs gated properly,
  toolchain installs never gated at all, and the server state store assumed the
  login was root. There's now one privilege resolver, and it elevates the write
  rather than the verify (so a `sudo` shell never resolves a different `$HOME`).
  A forced-command host that can't report a uid is no longer told to "connect as
  root", which was the opposite of its fix.
- **Language toolchains install per host, not per assumption** — the toolchain
  catalog and installer were rewritten onto the same host profile, so a bare-metal
  build on a non-Debian box gets its runtime installed instead of a
  `not found` at build time.

### `openship edge`

- **The whole reverse proxy, from the terminal** — a new top-level command:
  `edge up` stands the proxy up and serves `:80`/`:443`, `edge migrate` takes over
  an existing nginx/Apache/Caddy and imports its sites, `edge takeover` and
  `edge free` claim the ports, `edge sites` lists what could be imported, and
  `edge repair` diagnoses why it isn't serving (`--fix` resolves a port
  conflict).
- **Domains, rules and traffic without opening the dashboard** —
  `edge domains add app.example.com --port 8080` registers a hostname against a
  port and issues a certificate; `edge rules` manages per-route rate limits, bans
  and geo/CIDR access; and `edge traffic`, `edge analytics` and `edge logs` read
  what the proxy already records. Host operations are Linux-only; the
  control-plane half works from any machine, including desktop, against whichever
  context is active.
- **Documented as both reference and walkthrough** — a new
  [The edge](https://openship.io/docs/guides/the-edge) guide for the tasks, and a
  full [command reference](https://openship.io/docs/cli/edge).

### Resource limits

- **Self-hosted containers are unlimited by default** — a self-hosted project
  silently inherited the cloud free tier (0.5 vCPU · 512 MB) and OOM-killed
  memory-hungry images. On your own box the container's real ceiling is the
  machine, so `0` (no limit) is now the default and every consumer tests for a
  limit before applying a cap.
- **A custom cap is bounded by the actual machine** — caps were validated against
  hardcoded constants (4 cores / 8192 MB), so a 64 GB box could not be told to
  give a container more than 8 GB. The ceiling is read from the Docker daemon's
  own `/info` (`NCPU`, `MemTotal`) — identical for the local socket and a remote
  daemon over the pooled SSH bridge — falling back to the OS when Docker isn't
  reachable. Cloud is unchanged: a metered workspace is still sized from the tier
  table.
- **Deploys preflight the target's capacity** — a cap larger than the host can
  allocate is rejected before any build work starts, with the machine's real
  numbers in the message.

### Openship Mail

- **Run the instance as a mail product** — an instance can present itself as
  Openship Mail (`OPENSHIP_PRODUCT`, or a toggle in Settings): the left rail
  becomes the mail control plane — the ten admin tabs promoted to nav entries
  across three headings, plus the host and settings rows an operator still needs —
  and the platform nav is hidden. This is presentation only, never an
  authorization boundary: webmail still deploys through the ordinary project
  pipeline, so platform endpoints stay live. Cloud is always the full platform.
- **Switch between mail servers** — the mail surfaces are scoped to a selected
  server rather than assuming one, with a switcher in the shell and the scope
  carried through the admin tabs.
- **Outbound relay providers are real identities** — the relay code carried a
  `"ses" | "custom"` union, so SendGrid, Mailgun and Postmark lost their identity
  the moment they were saved: no SPF include, no round-trip in the UI, and adding
  a provider meant editing an `if` in the service, the DNS builder and the
  scanner. Per-provider facts are now data that all three read, and split
  delivery (receive here, send through someone else) is a first-class setup.
- **"Is mail actually leaving this box?"** — the daemon sweep reports that nine
  processes are running, which says nothing about whether Postfix can hand a
  message to the next hop. One wrong character in a relay password gave nine
  green daemons, green DNS, a Test-tab email that reported success (our Postfix
  accepts and queues before the relay hop), and mail that quietly deferred
  forever. Outbound delivery is now probed and surfaced on its own, with a
  reworked Health tab and a summary that names the failing hop.
- **A mail console** — live engine output in the dashboard, so a setup that stalls
  can be read rather than guessed at.
- **Backups you can schedule** — the mail admin Backup tab gains a real schedule
  and retention plan, wired to the same pruning the rest of Openship uses.
- **Setup fails earlier and clearer** — a preflight checks the things that used to
  surface mid-stream (password shape, firewall step, DNS), and setup errors render
  in a banner instead of vanishing into the stream.

### Webmail

- **Webmail is an ordinary catalog app now** — it installs through the same
  generic installer, image, volume and routing pipeline as every other app, and
  installs from /apps just as well as from /emails. The mail-specific part is the
  only part that stayed: which IMAP/SMTP backend it belongs to — one of your
  Openship mail servers, or an external provider.
- **The link is stored, not parsed out of a slug** — the old lookup read
  `webmail-<serverId>` back out of the project slug, which the generic installer
  never produces, and which mislinked any project someone happened to name
  "Webmail Prod". It's a real foreign key now, nulled (not orphaned) when the
  webmail project is deleted, with a legacy-slug fallback that stamps the column
  the first time it resolves a pre-existing install.
- **Its own image and database bootstrap** — a dedicated webmail Dockerfile and a
  bootstrap script, so first boot provisions its schema instead of depending on
  the mail engine's.

### App catalog

- **Five new one-click apps** — Meilisearch, Redis, PostHog, Umami and Neon
  (Postgres), each declaring its internal connection so it can be linked into a
  project over the internal network.
- **Badges that tell you what you're installing** — verified, unverified and
  hosting-mode badges with explanatory tooltips, so a community template isn't
  visually indistinguishable from one Openship has booted and checked.
- **Catalog schema updates** — the published `app.schema.json` gains the fields
  behind the above, and the reference docs and "Add an app" guide were rewritten
  around them.

### Routing & domains

- **A deploy stops wiping your `vercel.json` routing** — `registerRoute` replaces
  the whole vhost, so a caller that omitted `cleanUrls` / `redirects` / `headers`
  didn't leave them alone, it deleted them. Those fields were built inline in two
  places, so a plain deploy neither applied them nor preserved them, and an
  unrelated redeploy silently erased whatever a "Retry routing" had installed.
  They're now compiled once, in a pure module every route-registration site
  carries.
- **One decision about what the edge dials** — a single resolver owns the
  `proxy_pass` target: a pinned loopback host port by default (stable across
  restart, never internet-facing), the container's bridge IP as an advanced
  option, and a transparent fallback to the container IP for an internal Compose
  service that publishes no host port. Selectable per instance, with `auto` as the
  default.
- **A domain redirect survives certificate issuance** — the redirect installed
  for a hostname is no longer reverted the moment certbot succeeds, and it no
  longer re-fires on internal rewrites.
- **Real client IPs at the edge** — the real-IP configuration is derived in one
  place for every scope, so free subdomains and custom domains agree on what the
  visitor's address is.
- **Route rules have an end-to-end suite** — per-route rate limits, bans and
  access rules are covered by an e2e test that drives the real proxy.

### DNS

- **Cloudflare DNS, wired in** — connect a Cloudflare token and Openship writes the
  records a domain needs itself (#37), issues wildcard certificates over the
  DNS-01 challenge, and can route a domain through a tunnel instead of an open
  port.
- **We only touch records we created** — the provider claims a record it wrote and
  leaves everything else in the zone alone, and it refuses to write a hostname it
  hasn't claimed. Deleting a domain in Openship therefore cannot remove a record
  that was already there.

### Servers

- **One add-server form** — the page and the modal were two 400-line forks that
  had drifted; they're now one component with a variant, so a field added in one
  place exists in both.
- **Paste or upload an SSH private key** — `ssh_key_path` points at a file on the
  API host, which is useless on a remote or VPS instance where your key lives on
  your own laptop. A key can now be pasted or uploaded from any browser, stored
  encrypted at rest, never serialized back to the client, and preferred over the
  on-disk path when present.
- **The server page's connection banner explains itself** — reachability, host
  channel state, and what each one does or doesn't affect, rather than a single
  red dot.
- **Deploy defaults can't be set to something derived** — the instance default
  target is a server or cloud; "this machine" is derived (on a server-host box it
  is already in the server list), so it's no longer an option that means two
  different things.

### Projects & deploys

- **Rename a project from its heading** — a rename modal, plus copy-id and
  pause/resume, on the heading where the name actually is. The slug stays
  immutable (it's infrastructure identity); the display name is free.
- **Container actions go through one pipe** — pause, restart and logs run through
  the same deployment-runtime path as everything else, so they can't disagree
  with the platform about which host or runtime a service lives on.
- **Reconcile and teardown are steadier** — record-only deletes, orphan GC
  scheduling, pending actions and port checks were tightened around the same
  runtime path.
- **A project's source, build and runtime are three separate things** — two
  boolean flags (`hasBuild`, `hasServer`) each stood in for two different
  concerns, so a deploy could be accepted and then fail a stage later. A project
  is now described by three orthogonal axes — where the code comes from (git, a
  prebuilt image, or an upload), how it's built (Dockerfile, buildpack, static,
  or nothing to build), and what runs afterward (web, worker, or static) —
  resolved in one place that every stage reads. Existing projects classify
  exactly as they did before.
- **A private-repo Dockerfile app clones again** — a Dockerfile build runs no
  buildpack step, so it naturally carried `hasBuild=false`, and the one gate that
  decides whether to fetch a clone token keyed off that flag — dropping the token
  and failing the clone on a private repo, even though the Dockerfile needs the
  repo as its build context. Whether the code is fetched now depends only on
  where it comes from, never on how it's built.
- **A worker is a first-class deploy type** — a long-running process with no port
  (a queue consumer, a bot, a cron loop) had nowhere to go: called a server it
  failed preflight for a missing port, called static it was routed through
  file-serving and failed for a missing docroot. `worker` is now its own
  workload — built like any other app, run as an always-restart container with no
  port and no route, and checked for a start command instead of a port. Choose it
  from a project's Server / Worker / Static switch, or set `workload: worker` in
  `openship.json`.

### Compose & install

- **`up` preserves your `.env`** — a variable you set by hand is kept and marked
  as yours, instead of being regenerated out of a fixed key list.
- **A secret is never rotated out from under a running install** — `up` detects
  that it would mint a secret an existing install already has (which would leave
  encrypted env undecryptable), and refuses rather than silently replacing it.
  The replaced `.env` is kept for recovery.
- **Image versions can be pinned** — an explicit `--image-version` wins over the
  environment and the CLI's own version, for the case where a release reaches npm
  ahead of its images reaching the registry.
- **A foreign Postgres data directory is refused, not adopted** — the volume's
  contents are probed before a cluster is started on top of them.
- **`openship doctor` and `repair` cover more** — the host channel, an
  unprovisioned install, and port conflicts, in the same run.
- **Adopting a Compose stack no longer re-publishes its host ports** — a migrated
  `5432:5432` would bind host `5432` on the next deploy and collide with whatever
  already held it (often Openship's own Postgres), aborting the deploy. Adoption
  keeps only the container port; the service is reached by name on the project
  network and re-exposed from the Domains tab. The warning tells apart a port that
  was published off-box — Docker's publish rule routes past the host firewall, so
  it was genuinely reachable from the internet — from a loopback-only one, so you
  know whether any external reach was actually given up.
- **`stop_signal` and `stop_grace_period` are honored on redeploy** — a service
  that asks for a longer shutdown window now gets a graceful stop, with its own
  signal and grace period, before it's replaced or torn down, instead of being
  `SIGKILL`ed mid-write by an immediate force-remove. A container that doesn't opt
  in still stops the fast way, so there's no added redeploy latency.

### Agents & access control

- **Grant an automation a shell on one resource, not the whole organization** —
  the only way to let something run a command was a custom-command job, whose
  grant reaches every server in the org and can't be narrowed. Command execution
  now hangs off each resource's own permission: a grant on one server
  (`server:admin`) is a host shell confined to that box, and a grant on a project
  (`project:service:write`) runs commands inside that project's service
  containers — nothing wider. Every run is audited with its command, working
  directory and result, and container exec is refused on a runtime that can't
  isolate it.
- **AI agents get exec over MCP** — two new MCP tools expose host and in-container
  execution, each requiring the matching per-resource grant, with a hard timeout
  and an output cap (the agent's call blocks on the reply and the whole body lands
  in its context). Tools that only work on a self-hosted box are now hidden on the
  hosted platform, instead of being advertised there and returning `404`.
- **One access editor, and a live agent can be re-scoped** — the MCP consent
  screen, personal-access-token scoping and member grants were three separate
  editors and are now one. A connected agent's access can be edited in place from
  Settings — narrowed, or widened (widening to unscoped asks first) — and applies
  on its next request, with no disconnect-and-reconsent.
- **The scopes you could always enforce are now grantable** — several platform
  areas (jobs, notifications, analytics, settings, updates, cloud) could be
  checked for but never handed out, so there was no middle ground between "deploy
  only" and "the whole account"; they're grantable now, with billing and audit
  marked sensitive. Listing a collection honors a wildcard grant too — a token
  allowed to read a server by id no longer 404s when it tries to enumerate them.

### Desktop

- **Local deploys are gated behind an explicit "coming soon"** — desktop mode is
  built to control remote servers; running the workload on the desktop itself
  isn't enabled yet, and the UI now says that once, in one place, instead of
  offering a target that fails later.
- **Shell hardening and a safer updater** — see Security above.

### Docs & site

- **New and rewritten pages** — "The edge" guide, the `openship edge` command
  reference, host-channel troubleshooting, a rewritten "Add an app" guide and app
  catalog reference, plus notes on installation, updating and logs/monitoring.
- **Docs get social previews** — generated OG images per page.
- **A better changelog page** — entries collapse to headlines and expand to
  detail, with controls to expand or filter, driven by this file.

### Fixes

- **Zero-auth login doesn't bounce a remote browser forever** — an instance with
  no sign-in form grants its session only to a browser on the same machine, so
  bouncing a remote one was guaranteed to fail, leaving a spinner and then either
  a connection error for a host that isn't yours or an endless redirect. The page
  now names the cause.
- **Mail retention pruning respects mail backups** — pruning no longer considers
  a mail engine backup an ordinary project artifact.
- **A migrated container joins the network it's routed on** — a same-server
  migration attached a container that was never published, leaving it unreachable
  behind a verified domain.
- **Cancelling a build stops every build path** — cancellation reached some paths
  and not others, so a cancelled build could still be deployed: remote Docker
  builds kept running, and the static extract went on to publish the output of a
  build you had already stopped. A cancelled deployment is now terminal.
- **A no-op compose redeploy doesn't take over the active release** — a redeploy
  where every service was carried forward unchanged settled without advancing, so
  it no longer displaces the release that is actually running.
- **A stored healthcheck survives the settings form** — editing project settings
  preserved the healthcheck test rather than dropping it, and a `NONE` test array
  reads as disabled instead of as a command.
- **A finished dump stops hanging** — exec-stream sinks close on EOF, and the
  upload stall bound matches the producer's idle budget, so a completed backup
  can't wait forever on a stream that already ended.
- **A Dockerfile project needs no command** — projects that rely on the image's
  own entrypoint deploy without one.
- **Every new string is translated** — the release's new copy landed across all
  shipped languages, with the parity test extended to the new namespaces.

## 0.6.1

A large release. It adds a full service-to-service networking plane, around-the-clock
container health monitoring, and real analytics with visitor geography and usage
history — plus a self-contained containerized mail engine, a fleet-wide
infrastructure view with one-click updates, an audit log you can filter and attribute,
Telegram alerts, and a Node-based installer that retires the last of the Bun crash
class.

### Service-to-service networking

- **Any project can now be wired into another over the internal network** — every
  project (a plain single-app, a raw Compose stack, a monorepo, or an imported one)
  now shows a Connection card with its internal address (`http://<alias>:<port>`) and
  can be picked as a "Use in a project" source. Previously only catalog apps with a
  declared connection block, or multi-service Compose stacks, were internally
  reachable; a single-app project had no internal address at all. Same-boundary
  reachability is automatic and crossing a boundary stays explicit — an alias only
  becomes reachable once you link a consumer onto the network. Self-hosted only, and
  skipped for static sites (no listening port) and cloud-hosted apps (which link over
  Public instead).
- **Give a service a custom internal hostname** — a service can carry a custom
  east-west DNS alias that resolves alongside its default name, set from the service's
  Settings tab and available to single-app, Compose, and monorepo services alike.
  Openship normalizes it to a valid hostname and rejects one that collides with
  another service on the same project network, and the internal-address card shows the
  alias its containers actually answer to. Self-hosted only.
- **A clearer service Settings editor** — the service Settings tab groups fields into
  labelled sections and swaps free-text boxes for structured editors: ports and
  volumes are entered as chips (with per-item limits enforced as you type) and
  depends-on is a picker of the project's other services. The image and
  build-from-source fields are shown together — fill either, and a build context wins
  over a stale image — instead of an image/build mode toggle.

### Container health & incidents

- **Openship watches your containers around the clock, not just at deploy** — until
  now a container was health-checked exactly once, during the ~15s window right after
  a deploy, and then never looked at again unless a human was staring at the project
  page. A new health watch polls every server's Docker daemon once a minute (and
  reacts within about 10 seconds when Docker itself reports a container dying or
  restarting), so an app that falls over or drops into a crash loop at 3am raises an
  alert through your existing notification channels instead of waiting for a user to
  complain. Self-hosted only.
- **Broken containers page you once, not every minute** — a container stuck in a
  restart loop is broken on every poll, so a naive watcher would fire 60 alerts an
  hour about one fault. Instead each fault becomes a single incident: one message when
  it opens, one more only if it gets strictly worse (unhealthy → crash looping → down),
  and one all-clear that tells you how long it was down. A fault must be observed twice
  before it notifies, and an in-flight deploy, an operator's own `docker stop`, or a
  disabled project never trips a false alarm.
- **An unreachable server is one alert, not one per app on it** — when a box's Docker
  daemon stops answering, Openship opens a single server-level incident that names how
  many projects it can no longer monitor, and freezes those projects' health rather
  than falsely marking them recovered. The record is durable, so a box that has been
  down for days does not re-page every time the control plane restarts.
- **A Health tab on every project, with 30 days of incident history** — each project
  gets a Health tab listing its currently open incidents plus a rolling 30-day history
  of resolved ones with downtime durations. It also states whether monitoring is
  actually switched on (an operator toggle in the Jobs module) and surfaces the
  server's own outage when a box is unreachable, so an empty tab is never misread as
  "all good." Self-hosted only.

### Analytics & resource usage

- **See where your visitors come from** — the Monitoring tab draws a per-country
  choropleth of visitors alongside a ranked list, and animates real-time request
  ripples fed by the same stream the Logs tab tails, so you can watch where requests
  are landing right now. It works the same way self-hosted and on Cloud, and it can
  tell "no visitors yet" apart from "geo lookups aren't set up on this box," which
  used to render identically as an empty map. On a multi-domain project the whole
  view scopes to a chosen domain.
- **Visitor counts are real numbers now, not request counts** — the dashboard's
  visitor figure was a request count relabelled "unique IPs," so five page views from
  one browser counted as five people. It's now a genuine count of distinct visitors,
  deduplicated at the edge with a per-day salted hash that never stores an address or
  a per-visitor row — the number is honest while still collecting no behavioural data
  on your end users.
- **Top Paths and response codes that have real data behind them** — the Top Paths
  table was hardcoded empty and error rate couldn't be answered from anything saved.
  Both are real now: the daily rollup records normalized request paths (query strings
  stripped, ids collapsed, so tokens never become keys) and the full status-code mix,
  and a new card expands each 2xx/3xx/4xx/5xx class to the exact codes beneath it. On
  self-hosted, per-path aggregation is opt-in per project (a toggle, default off,
  including on existing projects) because it adds measurable work to every request the
  edge handles; on Cloud paths are aggregated automatically. Every other analytics
  dimension is unchanged.
- **Usage history is kept, so you can see what led up to a crash** — CPU, memory and
  network usage used to exist only as a live stream that vanished when you closed the
  tab, so "was memory climbing before it got OOM-killed at 3am" had no answer. Usage
  is now sampled on a schedule into 5-minute buckets and charted over time, per
  service. A Compose project reports its whole stack with a per-service breakdown and
  an All/service scope picker instead of just the one container the primary service
  owned; a static site (nothing to measure) now says so plainly instead of showing
  four zeroed metrics. Self-hosted Docker deployments; bare non-Docker deployments
  report zero network, since per-process accounting isn't available there.
- **Busy domains keep their analytics** — a domain pushing more than about 2 GB in a
  single minute (roughly 286 Mbps — routine for video or large downloads) used to
  overflow a 32-bit byte counter and kill the analytics scrape for that entire domain,
  so the busiest sites were precisely the ones with no analytics. The bandwidth
  counters are now 64-bit and collection keeps up. Self-hosted edge.
- **Analytics no longer quietly vanish when nobody is looking** — traffic analytics
  live in the edge's memory under a TTL and were only flushed to the database when
  someone opened a project's Analytics tab, so a project nobody viewed for a day lost
  its per-minute data. A background scrape job now persists every server's analytics
  on a schedule whether or not anyone is watching, collecting a whole server in one
  pass instead of a separate memory scan per domain.
- **Chart tooltips are readable in every theme** — tooltips were effectively
  transparent in the dark themes (plot lines showed straight through the text) and on
  light cards the hover marker rendered as a stray white block below the tooltip. Both
  are fixed with a shared tooltip style reused across the monitoring and billing
  charts.

### Edge & reverse proxy

- **Tune the reverse proxy per project** — a project's Routing settings now expose a
  full set of proxy tunables instead of a handful: raise or entirely remove the upload
  size limit, set connect/read/send/keepalive timeouts, control response buffering and
  gzip level, turn on HTTP/2, tighten request-header limits, and verify TLS to the
  upstream — each value validated before it reaches the generated nginx config and
  labelled with its own directive name. On self-hosted it also reads back what the
  edge is actually serving next to what you saved, flags any drift in colour, and
  offers a one-click adopt, so a hand-edited vhost or a value the sanitizer dropped
  can't quietly disagree with your settings. Self-hosted only.
- **Per-country analytics and country rules work on the containerized edge** — the
  containerized edge shipped without the MaxMind geo library or its country database,
  so every lookup returned nothing: no per-country analytics were recorded, and
  country-based route rules failed closed (a single-country ban silently blocked all
  traffic). The library and a GeoLite2 database — parsed and validated before shipping
  — are now baked into the edge image, so geo works from a box's first install with no
  runtime download.
- **Correct visitor identity behind Cloudflare or a load balancer** — behind a proxy
  the edge treated the proxy as the client, which broke four things at once: visitor
  country resolved to the PoP, distinct-visitor counts collapsed, per-IP rate limits
  put the whole planet in one bucket, and IP bans banned a PoP instead of a visitor.
  The edge now recovers the real client address from `CF-Connecting-IP`, trusting only
  Cloudflare's published ranges as the connecting peer.
- **Per-route rules reach the edge even when it isn't on the API's loopback** —
  pushing a project's route rules to a local edge now goes through the same resolved
  edge-management path as the rest of Openship instead of assuming the edge lives on
  the API host's own loopback. On setups where it doesn't — such as the containerized
  edge — rate-limit, ban, and country rules now actually take effect.
- **The "Edge ready" pill matches the server's real state** — edge readiness is now
  read from whether Openship's edge container is actually running, the same fact the
  Infrastructure tab and System Health use. Before, a leftover bare-host OpenResty
  install could make the pill claim "ready" while the server tab reported the edge as
  down.

### Custom & free domains

- **Free `.opsh.io` domains only route to a server whose control you've proven** —
  Openship Cloud's shared edge now forwards a free subdomain to your server only after
  that server answers a challenge proving it owns the target, a proof that lasts 90
  days and that Cloud re-checks about a week before it lapses. Openship prepares the
  box to answer the moment you set up its edge, so a free domain added later works
  without a redeploy, and a background sweep re-asserts, reads back over the server's
  own public address, and re-verifies anything expired — so a box left undeployed for
  months no longer silently loses its free URLs. A slug can't be pointed at someone
  else's box, and a server that can't yet answer is told why. Requires Openship Cloud.
- **Free and custom domains now work on static sites** — adding a free `.opsh.io`
  domain to a static project used to register nothing on the edge, so the URL fell
  through to the wildcard with no origin behind it; editing a static project's domain
  wrote no vhost until the next redeploy. Both now emit a real route the instant you
  save, serving the project's built files — the same behavior proxied apps already had.
- **A certificate that issued but hit a snag afterward is no longer lost** — if an
  ACME order completed but a later step failed (the vhost rewrite, the reload, or the
  read-back), the domain stayed stuck in "provisioning" with no expiry recorded, which
  made it invisible to the renewal sweep — a valid certificate then sat on the edge
  and expired ~90 days later. Openship now re-reads the edge after a failed issuance
  and records a certificate that's actually present, so renewal stays scheduled.
- **Invalid custom domains are rejected at the door** — setting a custom domain to
  something that isn't a public hostname (`localhost`, a bare IP, a single label, or a
  value with a path/port/scheme) used to return success, mint a dead pending-domain
  row, and even write a `server_name localhost;` vhost onto the shared edge. The write
  paths now validate custom hostnames and refuse bad ones, while still letting a
  project that already holds a bad value edit and remove it.
- **Editing a free domain no longer shows a false "Action Required"** — a single edit
  could sync the same free subdomain to Cloud twice, and the two racing challenges
  reset each other's token, so the route worked but the project reported "Action
  Required" anyway. Callers that run their own managed-edge sync now suppress the
  duplicate, so each edit issues one challenge and the status reflects reality.
- **Redirects and upload limits take effect on save** — raising a route's upload limit
  or adjusting its timeouts now applies as soon as you save instead of waiting for the
  next redeploy, and a domain redirect is applied live to static-site domains too, not
  only to proxied apps.

### Email

- **Mail runs as a self-contained engine instead of taking over your server** —
  setting up mail no longer installs iRedMail's daemons directly onto the host or
  reboots the box. Postfix, Dovecot, spam and virus filtering, and DKIM now run inside
  a single `openship-mail` container with its vmail database in a Postgres sidecar,
  host-networked so mail still sees real client IPs and the edge stays out of the mail
  data path. Setup is down to eight steps whose only prerequisites are Docker and the
  openship edge, and every piece of mail state (queue, maildirs, DKIM keys, config)
  lives on host bind mounts, so upgrading is a pull-and-recreate that keeps your data.
  Self-hosted only.
- **Mail uses the same edge and TLS as everything else** — mail setup no longer stands
  up its own host OpenResty and certbot on the side. The certificate for
  `mail.<domain>` is issued through the shared openship edge, the same path every other
  domain's TLS takes, and it is now recorded for renewal like any other domain — a
  mail certificate on a containerized edge (no host certbot timer) used to simply
  expire ~90 days after install, silently; a failed renewal now raises a notification.
- **Mail servers set up before containerization keep working** — the move to
  containers is topology-aware, so a server whose mail was installed the old way
  (system daemons, database on the host) still reports accurate component health and
  stays fully manageable: SQL queries, outbound SES/SMTP relay config, and daemon
  restarts all target the right engine. When the engine genuinely is stopped or was
  never installed, admin actions now return a clear message telling you to restart it
  or re-run setup instead of a bare 500 leaking a Docker "No such container" error.

### Remote infrastructure

- **See every managed edge and mail container in one place** — a new Infrastructure
  view lists each server's edge and mail container with the image version it's running
  against the version this release pins (for example edge 0.4.0 → 0.5.0), and flags
  which are behind, stopped, or missing. An attention rollup surfaces the ones that
  genuinely need hands — an edge that's down, or absent on a box that hosts projects —
  separately from the ones that merely have an update available. Self-hosted only.
- **Update, repair, or install a container without touching a shell** — Update swaps a
  behind container onto the pinned image (rollback-guarded), Fix restarts a stopped one
  in place, and a server with no edge gets a one-click Install that runs the first-
  install path with 80/443 takeover consent. Each apply streams its pull/recreate/
  verify progress and survives a dropped connection, and a fleet-wide Update all /
  Restart stopped does the same across every server at once. Self-hosted only.
- **Auto-update your remote infrastructure on upgrade** — a new instance-wide toggle
  lets the control plane update every remote edge and mail container automatically when
  you upgrade Openship (its `APP_VERSION` moves forward), so your fleet's infra tracks
  the version you're running with no manual sweep. It's server-side, so it works on
  desktop too, distinct from the desktop app's own auto-update, and off by default.
  Self-hosted only.
- **Drift detection stays current on its own** — with auto-scan on (the default),
  opening the Infrastructure tab or the home page quietly runs one detect-only scan
  when the cached state is stale, throttled to about every 30 minutes per browser, so
  the attention dot reflects reality without pressing Scan. It only refreshes what's
  shown — it never applies an update, which stays the separate auto-update toggle.
  Self-hosted only.
- **Legacy boxes are no longer flagged as broken** — a server converted to the
  containerized edge kept listing its leftover host OpenResty as a component with an
  Update button for a config nothing loads; those superseded host modules are now
  dropped from the view. And a legacy host-native mail engine (systemd Postfix/Dovecot)
  that was quietly delivering mail used to show up as "Stopped, container missing" —
  it's now labelled as not containerized rather than inventing a version. Self-hosted
  only.

### Docker migration

- **Migrated sites keep the upload limit and timeouts they ran under** — when you move
  or take over a Docker stack, the reverse-proxy tunables the source vhost declared
  (upload size limit, upstream read timeouts) are now carried onto the migrated project
  before the new edge vhost is rendered. Previously the site silently reverted to
  nginx's 1 MB / 60 s defaults at cutover, so the first large upload after a move failed
  with a 413 and nothing tied it back to the migration. Adoption is additive: a limit
  you set by hand always outranks a value inferred from the old box. Self-hosted only.
- **Adopting a stack no longer republishes internal ports** — a compose service that
  published a container port on a random host port (a single-part `ports:` entry, e.g.
  a database's 5432 the source never truly exposed) is now left unexposed during
  adoption instead of re-published on the target, so a migration doesn't needlessly
  expose internal services or collide with whatever already holds a host port. The port
  is still shown in the wizard so you can route to it, and service-to-service traffic
  keeps resolving by name over the shared network. Self-hosted only.
- **The wizard tells you which env vars weren't carried over** — when adopting a
  foreign stack, environment variables that exactly match the image's baked-in defaults
  are dropped rather than imported as explicit config (the image still supplies them at
  runtime). The wizard now lists exactly which keys were skipped and why — common with
  Coolify/Nixpacks images that bake config as ENV layers — so you know what to re-enter
  if you later change the image.
- **No more phantom hostnames in the import wizard** — the wizard used to invent a
  hostname from the project name whenever a step had no route chosen, labelling port
  fields, previewing monorepo sub-app hosts, and even wiring the "Visit Site" button to
  a host that would never exist. It now shows only hosts your config actually names, and
  hides "Visit Site" entirely when the deployment has no public domain.

### Audit log

- **See exactly what your AI assistant changed** — every audit entry now records where
  the action came in from (the dashboard, an MCP client, the CLI, the API, a webhook,
  or the system itself), and you can filter the log down to a single source. Isolating
  MCP-driven activity finally answers "what did the AI assistant do," which was
  impossible before because an MCP write and a CLI write produced identical rows.
  Entries written before this release show as an honest "unknown" rather than being
  mislabelled.
- **Turn auditing off and control how long it's kept** — each organization can switch
  audit recording on or off and pick a retention window (7, 30, 90, 180 or 365 days).
  Turning recording off stops new entries but never touches the ones already written,
  and the act of disabling is itself logged first, so the trail always explains why it
  went quiet. The switch is per-organization, so on a shared cloud instance one tenant
  can't disable everyone's audit log.
- **A real filter bar over the log** — you can narrow by category, actor, date range
  and free-text search, with a live count on every category tab. Search resolves
  project, server and domain names, so typing a name like "api-gateway" turns up
  entries that only ever stored an opaque id, and rows now display the human name of
  the affected resource, resolved server-side in one batched lookup per page.
- **Paging the log no longer skips or repeats rows** — entries that share a timestamp
  are now ordered by a stable tiebreaker, so scrolling through pages no longer
  reshuffles them; two entries created in the same instant could previously appear
  twice or vanish between pages.

### Notifications

- **Send alerts to Telegram** — Telegram joins email, Slack, Discord, and Teams as a
  notification channel: point a BotFather bot at a chat, group, or forum topic and
  Openship delivers your deploy, health, and job alerts there. The bot token is stored
  encrypted, and the channel list shows which bot does the sending.
- **Self-hosted notification settings drop the toggles that can never fire** — on a
  self-hosted box the billing notification categories are fed by the SaaS billing
  system, so they were switches that could never send anything. They no longer appear,
  and the remaining categories are organized into tabbed groups in Settings.

### Install & packaging

- **Openship now installs and updates on Node, never a global Bun** — the `curl | sh`
  and PowerShell installers download a self-contained, sha256-verified CLI payload that
  runs under Node: they use your system Node 22+ if you have one and otherwise vendor an
  official Node 22 from nodejs.org into `~/.openship`, and they quietly migrate you off
  any previous global-Bun install without touching your own Bun. `openship update` takes
  the same path — re-download the verified payload, refresh the runtime first — so an
  upgrade that raises the Node floor heals itself instead of breaking. This retires the
  Bun-vs-ssh2 crash class that could take out remote SSH operations.
- **The mail server ships as an official image** — Openship's official multi-arch
  (amd64 + arm64) image set, built and published to GHCR and Docker Hub each release,
  now includes `openship-mail` alongside the api, dashboard and edge images, so a
  self-hosted mail engine no longer has to be built from source.
- **`openship up` now works under rootless Docker instead of failing cryptically** —
  bringing up the compose stack on a rootless daemon used to abort the install with
  Docker's opaque "error while creating mount source path … permission denied," because
  a rootless daemon can't create the edge's bind-mount directories under root-owned
  paths. The CLI now creates those directories itself and, when it can't, prints the
  exact one-time `sudo mkdir`/`chown` commands to run (#372).

### Deployments & Compose

- **A working deploy is never recorded as failed** — build output that carried a raw
  NUL byte or a broken Unicode character (as a failed `docker exec` does when it spills
  its multiplexed stream, frame headers and all) made the log write fail, and Openship
  misread that rejected write as the deploy itself failing: a live, running deploy was
  marked failed and its containers torn down, while the deploy view stayed stuck on
  "Deploying." Stored build logs are now sanitized and size-capped, the outcome write
  sheds any log or error blob Postgres refuses rather than losing the status, and the
  terminal event that closes the live stream always fires.
- **Your Access URL and custom-domain ports survive a redeploy** — a project's deploy
  target is now stored durably on the project itself (a new `server_id` column) instead
  of living only in the latest deployment's volatile metadata. Before, a fresh or
  partial snapshot could lose that binding, quietly regress the project to a local
  deploy, strip the ports off its custom domains (a 502), and reset the Access URL to
  `localhost:3000`; existing server-hosted projects are backfilled so this can't bite
  them on the next redeploy. A verified custom domain is also preserved rather than
  deleted or blanked even when a deploy's endpoint set omits it. Self-hosted only.
- **A free-domain install now has a deploy target** — a box set up with a free
  `.opsh.io` domain could finish onboarding with no servers listed and nothing to
  deploy to, because registering the local "This Server" row hung off a bootstrap step
  that path never runs. The box now materializes its own deploy-target row when servers
  are first listed, when it connects to Openship Cloud, and on admin reset. Attaching a
  free `.opsh.io` domain to a project later no longer needs a redeploy first, since
  every deploy now primes the box to answer the ownership check. Self-hosted only.
- **Service domains honor your upload limit and proxy settings** — a compose service's
  own domain ignored the project's reverse-proxy tuning, so the main app would accept a
  50 MB upload while the same project's service domain rejected it at nginx's 1 MB
  default with a 413. Those settings now apply to every domain a project writes —
  per-service, static, single-domain composites, path fan-out, and single-app native
  deploys. Self-hosted only.
- **Catalog-app service URLs resolve per port and are never blank** — apps that route
  one container port to a domain and leave another port-only (Convex, for one) used to
  get an empty or self-referential origin injected (`CONVEX_SITE_ORIGIN=""`, or a
  `127.0.0.1` that inside a container points at the container itself). Each port now
  resolves independently, a port-only service falls back to the box's real reachable
  `http://host:port`, and a `{{publicUrl:…}}` token that still can't resolve is left
  unset — so the image's own default applies — with a loud warning in the deploy log
  instead of a silent blank.
- **The routing warning tells you when the edge is the problem** — when a deploy
  succeeds but its domains aren't being served, the post-deploy warning now checks why:
  if the edge container itself is down it tells you to bring the edge back up, instead
  of sending you off to your DNS provider to debug routes that are actually fine.
  Self-hosted only.

Upgrade note: this release bumps the pinned edge and mail image versions. On
self-hosted, open the new Infrastructure view to update each server's edge and mail
container onto the pinned image — or turn on instance-wide auto-update to have the
control plane do it on every upgrade.

## 0.5.0

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
  what a retained version _is_ on your project — built files for a static site,
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
  _after_ the apex had already succeeded, and the apex was reported as broken.
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

## 0.3.0

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
