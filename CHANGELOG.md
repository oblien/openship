# Changelog

All notable changes to Openship. Versions follow [semver](https://semver.org);
the in-app updater surfaces critical advisories from `release-advisories.json`.
Runtime security notices use the signed feed published from `security-advisories.json`.

## Unreleased

- **Recover PGlite after a container crash** — hold a Linux kernel file lock so
  reused PIDs cannot strand the database or admit an owner in another container.
  Preserve conservative checks for older locks and other operating systems (#1524).

- **Keep monorepo runtime images aligned with each service** — use the service's
  framework and selected builder for its runtime instead of inheriting an
  unrelated parent image. Fill missing builders from the stack registry, preserve
  explicit runtime selections for unchanged apps, and use the same resolution
  when checking whether runtime images can be refreshed.

- **Add a scoped Kubernetes manifest foundation** — admit supported resources into
  a project's namespace with ownership checks on objects, pod/job templates and
  selectors. Validate the full change against Kubernetes before writing, reject
  changed Job definitions, and preserve conflict checks when updating or pruning.
  Exercise apply, update and cleanup against K3s in CI and the release gate. This
  foundation does not yet expose a manifest upload UI or deployment route (#1039).

- **Preserve live Docker logs** — decode stdout and stderr independently across
  split frames and UTF-8 characters, keep TTY logs intact, and report malformed or
  truncated streams so the existing reconnect flow can recover (#1482).

- **Support verified self-hosted OIDC sign-in** — discover a configured identity provider and
  verify signed ID tokens, issuer, audience, expiry and sign-in nonce before
  creating sessions. Preserve invitation and two-factor checks, require matching
  UserInfo subjects, and refuse insecure or redirected provider endpoints. Require
  verified email, scope accounts to the issuer and exact subject, and keep instance
  OIDC disabled on Openship Cloud and outside local-account auth mode (#1489).

- **Keep BuildKit sessions alive** — answer Docker’s session health checks so
  builds can use optional secret mounts after long install/build steps. Close
  sessions on completion, cancellation, and transport errors (#1488).

- **Move digest-referenced images between servers** — use the reference restored
  by Docker load for migration's one-time deployment handover. Direct and relayed
  transfers no longer try to create a Docker tag containing a digest (#1526).

- **Move stateless single-app projects between servers** — deploy a project-owned
  app with no service rows through its single-app pipeline using the transferred image.
  Reject unsafe empty service scopes before copying data or stopping the source;
  reused containers stay outside the deployment scope. Single apps with mounted
  data remain unsupported and are refused before data movement (#1525).

- **Keep Cloud diagnostics available during replica startup** — allow bounded
  schema initialization to wait for another replica, while preserving the short
  write deadlines and local-log fallback used during normal operation.

- **Recover health after a service container is replaced** — refresh only the
  stale service binding when the continuous watcher verifies a healthy successor
  under the same active deployment. Preserve native and Compose service identity
  through managed edge updates and rollback; leave unrelated services and
  deployment history intact (#1496).

- **Scan private repositories with server credentials** — repository preparation,
  monorepo folder selection and branch rescans use the shared GitHub credential
  chain, including the selected self-hosted server's saved token. Without a
  selection, only the active organization's local server is eligible. Borrowing
  requires repository access and server write permission; SSH provisioning,
  GitHub mutations and Cloud authentication remain unchanged (#1500).

- **Match Laravel worker suggestions to production dependencies** — suggest the
  standard queue worker when Horizon is only in `require-dev`, matching the
  default Composer `--no-dev` install. Explicit role choices remain available (#1171).

- **Keep runtime roles available after removing attached services** — a single
  source app retains its existing deployment and role configuration flow after
  the last attached service is removed or disabled, preserving its service and
  routing identity (#1308).

- **Prevent false stale-role warnings after deployments** — background image
  cleanup updates storage measurements without changing the project's configuration
  revision. Real configuration edits still invalidate previously reviewed changes.

- **OpenShip Earn** — explain the Cloud affiliate program at `/affiliates`, with
  an interactive commission split, monthly and annual reward timing, payout
  guidance, and a dedicated social preview. Label the dashboard affiliate entry
  Earn with a gift-box icon in the left sidebar.
- **Start CockroachDB services correctly** — pass the required single-node
  command to the official image, generate an application password, and persist
  TLS certificates alongside the existing data volume. New services keep TLS and
  password authentication enabled; container replacement preserves both data and
  certificates. Include recovery steps for saved services missing the command
  (#1484).
- **Recover storage from slow build-cache scans** — when free disk space or inodes
  already block deployment, allow up to two minutes to measure unused, owned build
  caches before reclaiming them. Healthy hosts retain the short best-effort scan;
  defer timed-out SSH measurements during automatic retention without blocking
  unrelated builds. Explicit cleanup still reports measurement failures; active
  builders and application volumes remain protected (#1527).
- **Reclaim images from interrupted first deployments** — include projects that
  have never reached a running release in managed image collection. Resolve the
  last attempt through the existing tenant checks and retain the same rollback,
  retry, pin and in-use protections, so failed builds cannot fill the server with
  orphaned images.
- **Cloud affiliate program** — create and revoke referral links with optional
  customer discounts, follow verified payments, renewals and expiry, and request
  reviewed cash payouts. Staff can review pending requests in a private operator
  queue and reconcile transfers, including after an account is deleted.
  Oblien owns the ledger and atomically reserves payout
  funds. The default minimum is $50, with trusted per-user overrides. Eligible
  monthly and annual Cloud compute starts at $10 per month equivalent; Manage,
  PAYG and top-ups are excluded. Program guidance lives beside the referral lists,
  with illustrated empty states, a two-step discount and plan picker, monthly/yearly
  eligibility enforced at checkout, encrypted manual payout accounts with immutable
  request destinations, payment-method guidance and a screenshot
  walkthrough in the docs. The program remains off until the provider and
  its explicit policy grant are configured.
- **Review shared environment edits** — preview which services inherit an edited
  project variable, then save shared values and service overrides together. Stale
  reviews are rejected inside the write transaction; project write access is
  required, and saving alone does not restart applications.
- **Clarify referral checkout and earnings** — retain unavailable referral codes
  through sign-in until the customer removes them, and show commission per
  confirmed payment with renewals limited to the program's reward period.

## 0.9.5

This hotfix restores self-hosted Compose startup after the 0.9.4 update.

- **Restore dashboard readiness and edge startup** — bind the dashboard's Next.js
  server to `0.0.0.0` inside its container so the loopback healthcheck can reach it.
  Apply the same bind setting in the CLI-generated, reference self-hosted and
  from-source Compose environments. Published host ports retain their existing
  loopback defaults (#1461).
- **Test the complete customer upgrade** — gate image publication on upgrades from
  0.9.3 and the previous release using their published API, dashboard and edge
  images and CLI templates. Verify populated PostgreSQL and Redis storage, custom
  ports, preserved secrets, admin credentials and signed sessions, saved edge
  routing, dashboard-to-API access, cold
  restart and fresh installation. Probe both dashboard image architectures before
  publication; an API-only migration check no longer stands in for a stack upgrade.
- **Explain source rebuild prerequisites before a security refresh** — global and
  project advisory views use the same runtime-update preflight as the deployment
  action. Replayed or revisionless source images show their prerequisite and an
  **Open source redeploy** action instead of offering a refresh that will fail.
  Redeploy still uses the existing project deployment controls; source provenance,
  image pins and tenant authorization remain enforced (#1462).
- **Include the packaged-worker image correction** — source builds of managed
  workers require Git checkout metadata. Bundled Dockerfiles in the released API
  no longer trigger a development worker build.

### Recovery from 0.9.4

Run `openship update` after 0.9.5 is published. The update recreates the API,
dashboard and edge through the normal pipeline and preserves existing database,
Redis and application storage. For a temporary recovery on 0.9.4, set
`HOSTNAME: "0.0.0.0"` in the dashboard service's Compose `environment` and run
`docker compose up -d` with that installation's existing Compose file and project
name. A later CLI run regenerates that file; update to 0.9.5 for the permanent fix.

## 0.9.4

This release adds deployment to existing Docker Swarm clusters, reviewed database
replication, annual Cloud billing, Openship Manage support plans, runtime security
advisories, explicit monorepo app selection and edge password protection.
Deployment recovery, persistent storage, Cloud operations and webmail
receive reliability and security fixes. These notes cover changes since 0.9.3.

### Projects, repositories and environment

- **Choose which monorepo apps to deploy** — new imports ask for an explicit app
  selection instead of enabling every detected package or port. Add more apps,
  browse or enter repository folders, and retain saved selections, manually added
  roots, custom commands and private access when rescanning or reopening a project.
- **Keep large domain lists manageable** — the wizard groups routes by their
  owning app, shows a total and the first three rows, and offers View all. Apps
  using the same port keep separate domain ownership; changing deployment mode
  preserves the selected app's routes and privacy settings.
- **Build additional services from the repository** — Services and Topology share
  a From repository form with folder, build-context and Dockerfile selection.
  Save the service, then deploy it through the normal pipeline. Manual paths and
  retry remain available when browsing fails. Catalog selection gains compact
  source tabs, search and category filtering while retaining generated credentials.
- **Preserve Compose topology during detection** — a root Dockerfile alongside a
  Compose file retains the declared services and volumes even when framework
  detection also matches. Development-only Compose files beside ordinary framework
  projects remain opt-in; explicitly selected configuration retains precedence.
- **Skip unrelated workspace pushes** — single-app subfolder projects consider
  transitive workspace dependencies, shared build inputs and lockfiles before
  automatic deployment. The update banner uses the same decision. Configure
  `autoDeployPaths.include` and `exclude` for explicit rules; uncertain analysis
  keeps the deployment instead of silently skipping changes.
- **Read the requested source revision consistently** — retries and explicit-commit
  deployments read Compose files and `openship.json` defaults from that commit,
  instead of mixing an older checkout with the branch's latest configuration.
- **Use one effective environment view** — the Compose wizard and service editor
  resolve defaults and interpolation consistently while preserving the original
  templates and masked secrets. Save persists intentional service edits; existing
  projects also offer Cancel without writing changes. Revealed values and late
  lookup responses no longer restore an old value after saving.
- **Clarify saving and applying environment changes** — Save and Apply & restart
  describe their separate effects. Runtime-only values appear in a compact
  disclosure, unchanged image defaults no longer produce recovery warnings, and
  Apply can resolve an owned live legacy service without a populated per-service
  deployment record. Missing containers lead to the existing deployment action.
- **Complete GitHub connections and private clones** — hosted App setup, installation
  selection and attempt polling use the owning Cloud connection consistently.
  Self-hosted App creation sends a valid manifest redirect URL. Authorized
  same-owner private submodules receive scoped, short-lived credentials without
  persisting tokens in clone URLs or Git configuration.
- **Show where builds actually run** — remote Docker deployments no longer offer
  an unsupported local-image build or label a remote build as local. Genuine local
  bare builds and independent clone-location choices remain available.

### Deployments, storage and recovery

- **Pull managed worker images from packaged installations** — bundled workspace
  files no longer make a release installation look like a development checkout.
  Automatic source builds require Git checkout metadata; explicit administrator
  build contexts still work for source archives. Remote builds use the published
  protected worker matching the release.
- **Back up standalone app storage** — project backup policies now capture a
  single app's persistent volumes even when it has no service rows. Manual,
  scheduled and pre-deploy runs share the existing backup and restore flow,
  including integrity verification, confirmation and retention. App restore
  points remain distinct from deleted-service history (#1444).
- **Use release commands and roles with attached infrastructure** — supported
  self-hosted/Desktop Docker projects can keep one primary source app on the
  normal release-command, worker and scheduler pipeline while preparing attached
  private image services first. Infrastructure health gates app activation;
  retries, cancellation and rollback preserve confirmed databases and volumes.
  General Compose, multiple source apps, Cloud and cluster targets retain their
  existing role/release-command restrictions.
- **Explain unsupported role configurations** — refusals describe which saved
  release command or role must change instead of recommending the Docker runtime
  already in use. Eligible older projects without a persisted runtime mode can
  configure roles through the same runtime resolver as deployment.
- **Check required Compose variables before building** — validate the effective
  enabled service cohort before image builds, registry pulls or cutover. Errors
  list missing keys by service without exposing values; frozen rollback settings
  and explicit service scopes retain their existing precedence.
- **Retry a completed Docker build** — Retry deployment can reuse a retained,
  ownership-verified image after activation fails. It preserves the source
  revision and destination, with no rebuild or replacement pull. Missing artifacts
  fail clearly; unsupported bare/static and source-bind attempts do not offer an
  image-only retry.
- **Refresh runtime images deliberately** — the wizard exposes runtime versions,
  build images and production images. On-demand checks compare available image
  digests, and Refresh images & redeploy uses the normal readiness and rollback
  pipeline. Configured version tags, digest pins and deployment scope stay intact;
  unavailable comparisons remain unknown and pins never advance automatically.
- **Preserve the incumbent through eligible Compose replacements** — supported
  self-hosted Docker deployments can prepare an overlapping candidate when saved
  limits, measured headroom, port provenance and storage compatibility permit it.
  The old service remains until routing and the successful release are committed.
  Other targets keep normal replacement order; concurrent writable storage needs
  an explicit opt-in for the exact mount.
- **Settle interrupted routing recovery before admitting a retry** — a timed-out
  Compose recovery requests cancellation and waits for its in-flight route pass to
  finish before releasing deployment ownership. Uncertain recovery retains the
  containers needed for recovery instead of allowing a late route write to
  overwrite a newer deployment.
- **Keep image-declared data across redeploys** — self-hosted and Desktop-managed
  Docker replacements reuse stable project-owned volumes for image `VOLUME`
  declarations. Legacy storage is recovered from the exact verified outgoing
  container; missing or conflicting ownership stops deployment instead of
  attaching an unrelated orphan or starting with empty data. Explicit mounts take
  precedence, and retained owned volumes appear in deletion previews.
- **Require working persistence for bare deployments** — provision writable build,
  shared-data, process metadata and log directories through the deployment login.
  Persistence failures stop activation instead of silently leaving data inside a
  replaceable release directory. Hosts needing one-time permission setup receive
  actionable guidance.
- **Start a service with empty storage without erasing its old data** — writable
  named volumes offer Start with empty storage, with service-name confirmation and
  a preview of the new and retained volume names. The existing service deployment
  applies the change; failed admission can retry the same saved volume selection.
  Other mounts, backups and the previous volume remain available for recovery.
- **Adapt artifact retention to disk capacity** — Automatic retention can reclaim
  eligible older Docker release artifacts under measured storage pressure while
  protecting active releases, pins, shared references and ongoing work. Reclamation
  requires a verified rebuild or immutable-image recovery path. Managed idle-cache
  budgets scale with filesystem size; application containers and volumes are
  excluded from pressure cleanup.
- **Report useful restore failures** — when a Docker restore helper exits without
  delivering its diagnostic output, collect a bounded tail of its logs. Stalled
  or unavailable log reads cannot hide the original failure or indefinitely delay
  cancellation and helper cleanup. Restore ordering and the separate attach-input
  issue are unchanged.
- **Apply Compose control-plane updates reliably** — explicit updates recreate API,
  dashboard and edge services even when an earlier image prefetch already changed
  the environment. Updates wait for application readiness and report failures;
  PostgreSQL and Redis are not targets of forced recreation.
- **Expose per-service swap control** — opt into `resources.swapDisabled` for
  supported Docker services with a positive memory limit and verified swap
  accounting. Shared validation preserves the required cap across configuration
  edits. This changes the selected service, without changing host-wide swap or
  imposing new build limits.
- **Keep deployment timings accurate** — build measurements survive terminal
  outcome writes, service timings include image preparation, and measurements
  freeze before cleanup. Unknown durations remain unknown, skipped builds display
  `0s`, and untouched services do not acquire invented measurements.

### Clusters, scaling and topology

- **Deploy to an existing Docker Swarm** — Desktop and self-hosted controllers can
  inspect an existing Linux manager, connect its cluster, and deploy new application
  or Compose workloads through the shared deployment, routing, scaling and rollback
  flow. Nodes pull immutable image digests and use release-scoped secrets. Existing
  Swarm tasks and routing-mesh ports stay protected from standalone adoption and
  edge takeover. Moving a previously deployed project requires an explicit migration.
- **Review scaling and database replication** — Topology Scale reviews application
  changes before applying them. Self-hosted Kubernetes can manage PostgreSQL
  readers and authenticated Redis/Sentinel replication through the existing
  operators, with verified backups and explicit writer/reader connection changes.
  Reader removal checks dependent consumers; unsafe Redis reductions use a verified
  smaller copy that preserves the original until the connection switch is approved.
  Swarm application scaling remains supported; synchronized database replication
  requires Kubernetes and is separate from copying a database.
- **See database members in the overview** — primary and replica cards show their
  observed roles, health, servers and replication links. Larger graphs can switch
  to a compact view; Redis Sentinel voters remain distinct from data replicas.
  Missing observations do not invent a primary or a running member.
- **Make K3s setup and recovery clearer** — require cgroup v2 before installation,
  prefer This Server for the initial gateway/control roles, and correct private
  kubelet connectivity. Retries can migrate an unchanged Openship-owned legacy
  configuration and finish its required restart; edited or unverified configurations
  stop with bounded, credential-redacted diagnostics.

### Domains, ingress and certificates

- **Password-protect self-hosted routes and native previews** — configure a shared
  password at the OpenResty edge. Authenticated requests verify a signed browser
  cookie locally, without an API, database or Redis lookup per request. Public
  routes keep their existing path. Password changes and revocation invalidate
  sessions; protected responses disable caching.
- **Finish service routing and HTTPS together** — project and service domain saves
  share the existing routing preparation and certificate checks. First-route setup
  uses an inline progress viewer, retains explicit edge/DNS-01 consent, and refreshes
  canonical status after success or partial failure. A ready proxy no longer masks
  a failed or disconnected HTTPS check.
- **Publish redirect-only domains without a target port** — Compose `www`/apex
  redirects can reach the edge even when the domain has no upstream service port.
- **Leave route-free workloads independent of the edge** — private deployments
  without hostname routes skip unnecessary edge takeover, challenge and vhost
  preparation. Fixed-port services retain their explicit bindings; automatic
  allocations still require verified inventory and durable port claims.
- **Open pgAdmin without a custom domain** — PostgreSQL + pgAdmin supports an
  explicit Port only option while PostgreSQL stays internal. New catalog services
  also generate required PostgreSQL, MySQL, MariaDB, MongoDB and Typesense
  credentials instead of leaving their bootstrap secrets empty.
- **Keep catalog images available** — Convex uses its new official registry
  namespace with the existing version pin. The retired Mindwire Console/runtime
  template is hidden and disabled for new installs; existing project data stays
  unchanged.
- **Reuse valid parent wildcard certificates** — immediate subdomains can inherit
  a validated parent wildcard certificate when an exact certificate is absent.
  Exact certificates retain precedence; read failures preserve the working route
  rather than initiating replacement issuance or copying private keys.
- **Replace manual certificates without breaking renewal state** — remove only
  the selected hostname's obsolete Certbot renewal record after validation.
  Failed installation restores the prior certificate, key or archive links and
  renewal configuration before any reload; unrelated lineages remain intact.
- **Improve routing recovery and diagnostics** — control-plane setup can reclaim
  its own quarantined dashboard port without taking another workload's claim.
  ACME 502/504 errors describe challenge forwarding and the temporary listener;
  safe Cloud routing errors retain their actionable cause instead of blaming a
  healthy server connection.
- **Keep tunnel management in the route menu** — Cloudflare Tunnel settings move
  into the existing context menu, retaining per-domain Access settings, retry and
  readiness behavior without a persistent management row on every card.

### Cloud, billing, monitoring and Actions

- **Manage customer-owned infrastructure from Cloud** — Openship Manage Basic costs
  $5/month per organization with email support; Priority costs $20/month with
  priority support. Both include two connected servers, plus $3/month per extra
  server. Paid Cloud includes the Basic allowance once per organization; Priority
  retains its support fee. Expiration ends management access after the paid period
  while applications and data remain on the customer's hosts. Self-hosted control
  planes remain free.
- **Choose monthly or annual Cloud billing** — Hobby, Starter, Pro and Scale cost
  $12, $24, $47 and $119 per month, or $120, $240, $468 and $1,188 billed annually.
  The purchase view defaults to Yearly when supported by the provider, shows the
  monthly equivalent and full annual charge, and retains an explicit Monthly
  switch. Custom resources use the selected interval through quote, checkout and
  plan changes. Existing subscriptions retain their saved prices and allowances.
- **Update entry-level Cloud capacity** — new Hobby purchases include 1 vCPU,
  4 GB RAM, 50 GB storage and email support. New Scale offers allow 50 projects.
  These catalog changes do not rewrite existing paid contracts.
- **Simplify plan selection and payment recovery** — Cloud plans, Prepaid PAYG and
  Manage your server share the purchase view. Manage plans are also available
  directly when connecting a server. Pending purchases appear under Payments &
  invoices with a count, and Manage checkout keeps the server allowance and total
  beside the selected support plan.
- **Keep management billing and access coordinated** — durable checkout intent
  and receipt validation protect purchase retries. Paid Cloud organizations receive
  their included management allowance once, and allowance changes coordinate with
  server connections. Increasing recurring charges after Cloud coverage ends
  requires explicit consent.
- **Recover pending checkout conflicts** — explain when a purchase must be completed
  or cancelled, and open the existing payment recovery dialog. Checkout limits,
  pending resource changes, verification failures and cancellation in progress
  receive specific guidance instead of a generic retry message.
- **Reconnect Cloud usage streams** — interrupted read-only subscriptions recover
  from retryable disconnects with bounded backoff. Authentication failures,
  malformed data and stalled subscriptions still fail clearly; cancellation
  releases readers, requests and timers.
- **Recover orphaned Cloud terminals precisely** — refresh expiring namespace
  credentials for dispatch and teardown, then recover only the marked commands
  belonging to the interrupted operation. Ownership is cleared only after confirmed
  process exit; live controllers and another installation's claims remain protected.
- **Reuse scoped provider credentials and retain throttling guidance** — concurrent
  Cloud lookups share short-lived namespace tokens after ownership checks. Rejected
  token generations are invalidated without evicting newer credentials or replaying
  mutations. HTTP 429/503 and bounded Retry-After guidance survive the transport.
- **Explain resource-related deployment failures** — supported OOM, heap-limit and
  storage evidence produces a saved diagnosis and Review capacity action for the
  affected Cloud space. The explanation survives reloads and compacted logs. Long
  builds receive optional advice rather than an invented capacity failure;
  upgrades and retries remain explicit.
- **Reflect runtime incidents in project status** — known incidents on the active
  self-hosted workload show Action Required and link to Monitoring & Logs. Status
  clears after observed recovery; intentional stops, retired workloads and
  monitoring opt-outs do not create stale attention.
- **Calculate response averages from requests** — Overview and CLI traffic metrics
  divide total request duration by total request count, with consistent millisecond
  conversion for Cloud and self-hosted data. Uneven traffic and live/archive
  refreshes no longer inflate the reported average. Edge collection is unchanged.
- **Preserve active Actions runners through temporary API failures** — retry
  transient provider, GitHub and App-token renewal failures without cancelling
  the worker, releasing its capacity or silently falling back to broader user
  credentials. Persist supervisor completion before external cleanup and retain
  verified infrastructure errors when GitHub synchronization finishes.
- **Merge Actions history reliably** — local timestamps and Cloud date strings sort
  together without crashing the Actions page. Failed Cloud augmentation preserves
  the local run list. Service connection/unlink messages also reflect the existing
  automatic deployment attempt instead of asking users to trigger it twice.
- **Keep an active personal workspace during account changes** — deleting or leaving
  the selected team workspace restores the stored session owner's personal
  workspace instead of failing while clearing the active organization.

### Security and credentials

- **Patch the DOM test environment** — dashboard and webmail tests use Happy DOM
  21.0.4, which fixes the module import alias code-execution vulnerability
  (GHSA-834v-8h66-3h79).
- **Match runtime security advisories to deployed workloads** — verify a public,
  signed advisory feed and match affected image digests or observed runtime
  versions. New runtime rules, deployment changes and Check again refresh bounded
  container observations; ordinary polling reuses one current observation per
  project. Findings appear in the existing global critical/update banner with a
  shared affected-app review; no project visit is needed. The banner reads cached,
  workspace-authorized evidence without probing containers. Missing evidence stays
  unknown. Initial notices cover Node.js/Bun
  Brotli fixes and PHP's October security guidance, including a separate manual
  configuration warning that an image update alone cannot clear.
- **Apply reviewed patches through the deployment pipeline** — Refresh images &
  redeploy can pull a replacement behind the same tag, or rebuild the deployed
  Git revision with refreshed base images. Automatic refresh is off by default
  and requires explicit consent, a signed affected/fixed digest pair, an eligible
  image service and unchanged configuration. It pins the approved replacement,
  uses the normal refresh and environment-resolution flow, preserves persistent
  volumes, and verifies the deployed result. Late environment changes stop an
  automatic update for review. Concurrent requests admit one automatic attempt;
  rollback clears the one-time approval. Explicit digest pins remain fixed.
- **Deliver security notices through existing notification channels** — verified,
  enabled channels receive matching alerts by default, with a per-channel opt-out
  and durable delivery deduplication. Feed checks share authentication-aware
  polling, conditional requests and backoff with release updates: five minutes
  when authenticated, one hour without authentication. Advisory metadata cannot
  supply executable commands.
- **Pin patched runtimes and build tools** — use Node 22.23.4 and Bun 1.4.4 across
  the affected control-plane, website, webmail and worker image stages, with verified
  image digests. Desktop moves to supported Electron 44.9.2; Actions distributions
  use Go 1.26.9 and updated Git, archive, SSH/HTTP and telemetry dependencies.
- **Keep runtime regressions in release checks** — exercise the upstream Brotli
  decoder rejection case, streaming input, private-CA HTTPS, hostname verification
  and authenticated asynchronous WebSockets. TLS SNI is sent only for DNS names,
  and package-manager bootstrapping works when `node` is an alias to Bun.
- **Preserve authority across tenant and terminal boundaries** — service, server
  and proxied Cloud terminals retain the caller's credential restrictions and
  recheck expiry, revocation and current administrative access. SaaS-managed
  customer hosts use verified public destinations, SSH host-key pins and encrypted
  uploaded credentials; operator identities and private certificate-provider
  settings remain outside tenant-controlled host configuration.
- **Scope backup connections at use time** — Cloud S3/SFTP destinations pass the
  shared public-network checks before connecting to the validated address. Server
  SSH identity and existing host-key pins remain enforced for SFTP; self-hosted
  private backup storage stays supported.
- **Grant narrower token capabilities** — personal access tokens and MCP clients
  can receive project-scoped domain read/write/delete and deployment read/trigger
  permissions. Minting checks the creator's authority, and cancellation, rollback
  and deployment deletion retain their administrative requirement.
- **Protect remote Docker builds from metadata destinations** — rootful Linux SSH
  and Cloud builds use the project-owned BuildKit worker's IPv4/IPv6 metadata and
  credential-endpoint policy, including after restart. Missing required executor
  or policy support fails before repository commands; local Engine API, bare and
  Kubernetes builds remain outside this policy's scope.
- **Verify worker publication before releasing dependent packages** — publish and
  anonymously verify the protected worker for both supported Linux architectures
  before dependent image and bundled-release publication. Release receipts must
  match the tag and source commit; missing or private images stop publication.
- **Keep disabled preview services isolated** — disabled service copies retain
  their disabled state while host bind mounts and external host/container namespace
  references are removed. Named/anonymous volumes and sibling service references
  stay usable; production configuration is unchanged.
- **Separate webhook endpoint quotas behind shared addresses** — unrelated hooks
  no longer exhaust one another's source-IP bucket. Endpoint quotas share the
  existing limiter with a separate aggregate IP ceiling; authentication, signatures
  and credential redaction remain enforced.

### Desktop, webmail, website and documentation

- **Build Windows installers with patched runtimes** — stage SSH and Docker
  dependencies from a package manifest so version ranges do not pass through
  Windows command shims. The packaged dependency load check remains required.
- **Restore visible offline Desktop startup** — embed the shared generated theme
  palette in the native loading page so its text and artwork remain visible before
  the dashboard loads.
- **Repair older managed webmail host mappings** — backfill the missing host-gateway
  alias for the explicitly linked webmail service on its own self-hosted mail
  server. The repair preserves credentials and volumes and takes effect through
  the next normal deployment.
- **Preview Office attachments with bounded rendering** — XLSX, DOCX and CSV files
  gain readable, sandboxed previews with limits on parsing and rendered content.
  Unsupported, encrypted, corrupt or truncated content retains a download option.
  Active HTML/SVG/XML and unknown attachment types download instead of executing
  in the signed-in webmail origin.
- **Update mail and editor dependencies consistently** — align the patched editor
  dependency graph across direct and nested imports, update Nodemailer and
  Mailparser, and preserve reviewed runtime overrides in Docker and tarball
  packages. Existing SMTP modes and credential repair remain supported.
- **Keep public-page social previews intact** — pricing, marketing, catalog,
  feature, blog, changelog and mail-guide pages inherit the shared Open Graph and
  Twitter images while retaining explicit page images and metadata. The release
  checks validate the rendered image tags and their image responses.
- **Show GitHub stars in site navigation** — desktop and mobile navigation display
  the cached repository star count, with an accessible exact count and a fallback
  when GitHub is unavailable.
- **Improve operational guidance** — document Docker socket permissions and
  reconnecting after group changes, update the shared API/SDK/CLI/MCP references,
  and explain the supported cluster, recovery and runtime-image workflows.

### Upgrade notes

- Rebuild or recreate the affected control-plane and webmail deployments to apply
  their runtime updates. Explicit project runtime versions and image digest pins
  are preserved; updating Openship alone does not update every deployed app.
- Protected rootful SSH Docker builds require Buildx and root or passwordless sudo
  for the trusted worker policy and cache filesystem operations. Ordinary explicit
  CPU/RAM limits and unconfigured resource sharing retain their existing behavior.
- Existing-Swarm support is for Desktop/self-hosted controllers, with stop-first
  cutover and single-instance persistent services on the connected manager. It does
  not adopt arbitrary existing stacks or add hosted Cloud clustering. Managed
  PostgreSQL/Redis replication requires self-hosted Kubernetes operators.

## 0.9.3

This release improves Cloud monitoring and build-cache reliability, adds deployment
automation and isolated pull-request previews, and makes workers and schedulers
easier to configure, observe and recover. These notes cover all merged changes
since 0.9.2.

### Deployment automation and previews

- **Move command variables into Environment** — review literal environment
  assignments in install, build and start commands, then migrate them into
  encrypted project or service settings. Conflicts and concurrent edits stop the
  migration before partial changes are saved. Import and saved settings share the
  same parser and guidance.
- **Prepare framework output automatically** — Next.js standalone monorepos and
  Nuxt builds retain their required workspace dependencies, public/static assets
  and selected Node or Bun runtime. Managed direct-server defaults start from the
  configured app directory; explicit custom commands retain their working directory.
- **Review older manual cache mounts** — detect duplicate package/framework cache
  mounts and offer configuration migration only after a successful build proves
  managed cache support for those paths. Existing volume data is retained. Build
  logs report observed cache reuse and build-time comparisons.
- **Catch setup problems earlier** — pre-install checks identify missing app roots
  and environment examples; command-variable, standalone startup and duplicate-mount
  guidance explains what needs attention without exposing variable values.
- **Opt into GitHub pull-request previews** — same-repository, non-draft pull
  requests can deploy their exact commit into a separate preview environment with
  preview-only variables, isolated volumes and per-service URLs. Production
  variables are not copied. Forks and unsafe shared-storage configurations are
  excluded.
- **Recover preview lifecycle operations** — durable coordination handles repeated
  webhooks, controller restarts and retryable close/merge cleanup. Optional GitHub
  comments update one existing comment, alongside the existing deployment Checks.
  Whole-instance transfers preserve preview ownership; individual project imports
  clear preview automation that cannot safely transfer.
- **Use automation from the SDK** — configure and list previews, inspect or migrate
  manual cache mounts, and move command variables through the shared validated
  project operations.

### Workers, schedulers and rollback

- **Configure roles without rebuilding the web app** — Apps & Services → Configure
  roles can add or change workers and singleton schedulers on active single-app
  self-hosted Docker deployments. The normal deployment engine reuses the verified
  image and frozen environment while preserving the web container and unchanged
  replicas. The API, SDK and CLI expose the same operation. Cloud, bare, static,
  cluster and multi-service targets are outside this editor's scope.
- **See and inspect background processes** — runtime roles appear in project
  service views and topology, with role/replica log selection and retry states.
  Health monitoring includes worker and scheduler failures instead of observing
  only the foreground container.
- **Keep independent role suggestions** — framework scans expose matching presets
  at the selected app root. Only presets competing for the same declared slot
  exclude one another; explicit roles, including an empty list, retain precedence.
  Suggestions do not automatically enable background processes.
- **Recover interrupted role handovers** — persist exact container identities and
  ownership before replacement, predecessor shutdown and publication. Startup and
  deployment reconciliation either finish a published handover or safely restore
  its predecessor; uncertain cleanup remains pending before conflicting work.
- **Protect active and rollback images** — retained role replicas keep their
  required image artifacts protected during configuration changes and release cleanup.
- **Restore frozen Compose environment accurately** — rollback preserves encrypted
  deployment snapshots without confusing literal redaction-like values with missing
  secrets. Incomplete legacy snapshots fail clearly rather than borrowing mutable
  current service settings.

### Cloud monitoring, caches and storage

- **Avoid expensive monitoring scans** — Cloud hosts using fuse-overlayfs skip
  Docker's full storage inventory, which can exhaust daemon memory. Host totals
  remain measured; unavailable detailed project storage stays unknown.
- **Show guest RAM usage** — use verified guest counters instead of hypervisor
  process memory and overhead. Older guests receive a bounded, read-only memory
  sample; stream teardown releases the executor.
- **Keep partial metrics useful** — missing disk or memory fields in a live frame
  retain the latest measured value for that metric, with its measurement time.
  Purchased capacity is never substituted for measured consumption.
- **Keep Cloud cache cleanup scoped** — collect only owned, idle project-worker
  caches and stop before Docker Engine's global builder prune. Cache reuse, worker
  GC, existing build concurrency and user-configured resource limits are unchanged.
  Cloud builds require their isolated BuildKit executor instead of silently falling
  back to the embedded builder. Existing legacy daemon state and autonomous Docker
  GC remain separate host-maintenance concerns.
- **Accept filesystems without fixed inode totals** — unsupported or zero inode
  totals mean unknown availability rather than confirmed exhaustion. Real free-space
  and supported inode-exhaustion checks still protect deployment admission.

### Domains and ingress

- **Route verified custom domains on first deployment** — single-app domains
  without a saved destination use the verified serving port through the shared
  route planner. Explicit endpoints and service-group destinations retain their
  ownership instead of selecting a sibling service.
- **Avoid ephemeral secondary host ports** — secondary loopback publications use
  the existing allocator and the target host's ephemeral-range checks.
- **Handle varied Cloudflare Access applications** — accounts containing launcher
  or other domain-less applications no longer crash managed ingress setup.
  Inventory and write receipts are validated while overlap and foreign-resource
  ownership protection remain enforced.
- **Clarify edge availability** — documentation explains edge failure behavior and
  recovery responsibilities for deployed applications.

### Webmail

- **Resolve exact Message-IDs for actions** — thread reads, deletion, labels and
  flags validate exact IMAP envelope identities instead of trusting substring
  search matches. Literal percent sequences remain unchanged, stale UID hints are
  rejected, and missing or refused operations no longer report success.
- **Cache application assets correctly** — fingerprinted assets receive immutable
  caching while application HTML is revalidated.
- **Serve precompressed assets** — negotiate available Brotli or gzip files with
  appropriate content types, encoding and cache headers.

## 0.9.2

This patch adds worker and scheduler execution, personal appearance customization,
and managed Cloudflare Tunnel setup for self-hosted servers. Cloud spaces, reusable
build caches, more catalog apps and safer storage cleanup improve everyday
operations. These notes cover all merged changes since 0.9.1.

### Workers and schedulers

- **Run roles beside your web app** — declare workers and schedulers in
  `openship.json` or the project API. Single-app Docker deployments start separate
  containers from the app image, with shared environment, volumes and connected
  networks, their own commands and shutdown settings, and no published ports.
  Roles follow pause, resume, restart, rollback and project deletion.
- **Hand over singletons safely** — scheduler renames, command changes, name swaps
  and conversions into workers stop and retain outgoing singletons before starting
  potentially conflicting replacements. Failed deployments restore them only after
  those replacements are confirmed removed. Failed retirement of an old role is
  surfaced in the deployment warning with its container identity.
- **Require a verified startup** — every replica needs exactly one stable result
  for its container ID before optional exec health checks run. Missing inspections,
  duplicate results and processes that already exited successfully fail startup.
  Both project-defined and image-inherited `PORT` values are removed from roles.
- **Make role configuration explicit** — move and copy refuse active, unfinished
  or preserved-cancelled role workloads even after saved roles are cleared.
  Preset-only `when` and `unless` keys in declared roles produce warnings rather
  than silently appearing to control execution. Automatic framework role selection
  and cross-server role migration are not included.
- **Improve framework shutdown defaults** — Rails presets have measured stop
  settings, and Laravel's scheduler preset uses SIGTERM with a 10-second grace
  period while queue and Horizon workers retain 90 seconds. Customize these bounds
  for long-running tasks; they do not guarantee task completion or exactly-once
  scheduling. Laravel web-role cache warming is available as an opt-in setting.

### Appearance and dashboard

- **Customize your own appearance** — Settings → General → Customize previews
  color tokens and typography live, with explicit Save, Discard and Reset.
  Import themes from JSON, a file or an HTTPS URL; export themes and libraries,
  including supported WOFF2 fonts. Preferences belong to the signed-in user and
  stay isolated across accounts and instances. API, SDK, CLI and MCP operations
  use the same theme format.
- **Keep operational tools together** — project monitoring and logs share one
  navigation entry with their own views. Backups moves under Infrastructure.
  Project sidebars show assigned domains, migration retries retain destination
  choices, and migrated service deployments use the correct icons.
- **Reduce false outage alerts** — the health watcher confirms repeated bounded
  Docker probe failures before announcing a server outage. Late probe replies
  cannot falsely announce recovery. Self-hosted administrators can clear resolved
  monitoring history with confirmation while retaining open incidents.
- **Improve navigation and terminal reliability** — GitHub discovery no longer
  blocks dashboard pages, selection controls use consistent states, and leaving a
  server terminal during WebGL loading cancels setup and disposes the terminal.
  Instance connection and move actions have clearer setup and recovery guidance.

### Cloudflare Tunnel and domains

- **Manage self-hosted ingress from Openship** — Server → Security can connect or
  create a remotely managed named Cloudflare Tunnel using saved credentials,
  configure proxied DNS and optionally apply an existing reusable Access policy.
  Install a pinned connector on a supported Linux server or use its existing
  connector. Managed Openship Cloud routing retains its existing path.
- **Enroll domains with recoverable setup** — explicitly enable automatic tunnel
  enrollment for new custom domains or connect existing domains individually.
  Setup records Access, tunnel and DNS progress, supports retry after interrupted
  requests, and removes only owned resources. External edits remain visible for
  review instead of being overwritten. Exact hostnames and `www` companions are
  supported; wildcard auto-enrollment is not.
- **Choose primary and www behavior** — the deployment wizard defaults a newly
  included companion hostname to a 301 redirect to the entered primary. Choose
  bare primary, www primary or Serve both on Cloud and self-hosted destinations.
  Redirect rows show their target instead of duplicate runtime inputs.
- **Keep domain operations consistent** — service aliases on the same port are
  preserved, domains added through the CLI receive routing, and Cloud routing
  retries recover missing Pages through the owning Cloud connection.
- **Honor trusted proxies on containerized edges** — operator-declared proxy IPs
  reach the edge without rebuilding its image. Invalid addresses and CIDR prefixes
  are discarded. Failed configuration updates restore the previous shared trust
  include, and an incomplete rollback cannot activate a partial configuration.

### Cloud spaces, billing and connections

- **See managed capacity as Cloud spaces** — a shared picker, Overview and
  Activity views show projects, purchased capacity and measured usage, with clear
  retry states for unavailable readings. Existing allocations and subscriptions
  keep their identity; connected self-hosted server tools remain available.
- **Use the owning Cloud account consistently** — connected Desktop and
  self-hosted installations create Cloud projects through Cloud's API. Server,
  project and deployment operations enforce their organization and provider
  namespace. Cloud consent shows the actual account and organization and lets you
  switch either before explicitly authorizing the connection.
- **Continue purchases without repeating plan selection** — pricing links carry
  the chosen plan into the signed-in app's checkout flow. Pending unpaid payments
  can be cancelled when supported by the provider so another plan can be selected;
  retries retain the original payment identity. Server cancellation is easier to
  find and repeated requests cannot create duplicate operations.
- **Configure Actions on existing spaces** — Cloud's Add runner flow opens the
  capability form directly with the space picker. Local Actions lists remain
  available when Cloud discovery fails, and official runner containers support
  non-root SSH supervisors. Temporary runner profiles retain their separate
  funding flow.
- **Keep instance handoff with its source** — control-plane provisioning on a
  linked managed destination stays owned by the source controller until the move
  transfers the instance, including resumed API-only and dashboard installations.

### Build performance and resource control

- **Keep unconfigured resources uncapped** — omitted build and service CPU/RAM
  limits no longer become sampled capacity caps or catalog sizing recommendations.
  Containers share the selected server's capacity unless limits are explicitly
  configured. Cloud plans and VM capacity still apply. Existing saved limits are
  preserved; select Full capacity to remove an older unwanted limit.
- **Allow concurrent Cloud submissions** — different projects can submit builds
  while a sibling build is active. Unspecified resource dimensions remain shared;
  explicit limits, saved plan concurrency and exclusive maintenance protection
  remain enforced.
- **Reuse bounded project build caches** — compatible builds retain project-owned
  BuildKit state and supported package/compiler caches while temporary workers
  are removed. Idle cache collection uses retention targets and storage-pressure
  checks, preserving active workers, release images and application data.
- **Optionally warm new Cloud spaces** — operators can select a provider software
  disk with public build-image layers for new spaces. Matching images are pinned
  against their current upstream digest; unavailable or outdated packs fall back
  to registry resolution. Existing spaces are not reattached by an API redeploy.
- **Show what image preparation is doing** — registry pulls stream progress,
  preparation heartbeats and elapsed time into deployment logs. Build cleanup
  waits for tracked Docker commands to acknowledge completion, and static export
  publication normalizes public file permissions.

### Catalog, GPUs and shared databases

- **Add document, dashboard and media apps** — install Paperless-ngx, Wiki.js,
  Homepage, Immich and Jellyfin using pinned published images, persistent storage
  and protected initial setup. Homepage does not require a Docker socket.
- **Run self-hosted AI apps** — Ollama offers CPU or one NVIDIA GPU, and Open WebUI
  connects to an existing backend with protected chat access. These templates use
  connected self-hosted destinations, not managed Cloud capacity. vLLM remains a
  disabled preview pending hardware verification.
- **Deploy NVIDIA GPU services** — Compose import, SDK/CLI sync and adoption share
  validated GPU selection and Docker device requests. Server detection and picker
  hints help choose a compatible destination. Unsupported or conflicting requests
  fail before image acquisition or service replacement.
- **Skip unnecessary WordPress and Odoo builds** — new catalog installs pull the
  official images and mount setup helpers through the normal deployment engine.
  Existing installations retain their saved recipes; reviewed catalog repair can
  update the application service while preserving database siblings, credentials
  and data.
- **Share native databases explicitly** — Use in a project can connect ready
  native PostgreSQL or Redis databases to authorized projects in the same cluster.
  Saved grants and private network rules are checked together; ownership, backups
  and database management stay with the source project.

### Storage, deletion and migration safety

- **Separate fresh Cloud app data** — new logical volume names use immutable
  project IDs so reinstalling a deleted slug cannot adopt another project's data.
  Owned legacy mounts and explicitly imported volume identities remain intact.
- **Recover failed deletion clearly** — failed first installs offer the existing
  explicit data-removal option, including owned volumes with no container. Data
  retention stays the default. Cleanup failures remain retryable operations
  instead of making a partly deleted project appear Live again.
- **Preserve resources belonging to other projects** — teardown can retain stale
  Cloud route and network references whose foreign ownership is confirmed.
  Unreadable or ambiguous ownership still blocks cleanup, and owned networks are
  removed by immutable identity rather than a potentially reused name.
- **Avoid ephemeral host-port collisions** — Docker allocation checks the target
  kernel's ephemeral range for both saved preferred ports and fresh candidates.
  Unsafe legacy allocations move to a safe port during deployment; if no safe
  candidate exists, allocation fails before reserving a replacement.

### Mail, security and localization

- **Persist webmail backend connectivity** — webmail deployed on its mail server
  saves the host-gateway mapping through normal service settings and deployment
  snapshots while retaining the certificate hostname for TLS. Sign-in connection
  attempts have bounded timeouts rather than hanging indefinitely.
- **Connect existing mailboxes from Cloud** — the Emails screen installs the
  standard webmail client for existing IMAP/SMTP servers. It does not provision or
  administer a self-hosted mail server in Cloud; managed email remains Coming soon.
- **Repair containerized mail operations** — boot restores maildir ownership,
  backups and restores use the actual host-mounted mail path, and fail2ban uses
  valid nftables syntax and explicit private PostgreSQL sidecar credentials.
  Database and unban failures no longer report success.
- **Resize your inbox and reading pane** — drag the divider or use its keyboard
  controls. Desktop widths are remembered separately from the mobile layout.
- **Prevent dashboard clickjacking** — dashboard pages, authentication routes and
  redirects deny framing through CSP and X-Frame-Options. Customer application
  routing and headers are unchanged.
- **Expand translated guidance and documentation** — supported dashboard locales
  include preferences, transfer, jobs, issues, pricing, diagnostics and audit
  descriptions. The website adds a blog and broader feature discovery, alongside
  updated catalog, runtime-role, Cloud, API, SDK, CLI and MCP documentation.

Update the API as well as Desktop/dashboard clients before using the new settings,
managed tunnel operations or catalog recipes that require 0.9.2. The included
database migrations run through normal API startup.

## 0.9.1

This patch adds a public app catalog, Russian dashboard support and runtime image
controls. It fixes workflow saves and Cloud recovery, updates webmail live, and
improves routing, build capacity and image handling during redeployments. These
notes cover all changes since 0.9.0.

### Apps, language and workflow setup

- **Browse apps before installing** — the public website now has an Apps directory
  with search, category filters and individual pages showing features, included
  services and app overviews. Installation opens the existing Cloud setup flow;
  self-hosted users can follow the installation guide. Returning to the directory
  preserves search and category selections.
- **Russian language support** — select Russian during onboarding or in dashboard
  language settings. Dashboard translations cover workflow setup, Cloud reconnect
  and webmail recovery, and a Russian README is available alongside the existing
  localized introductions.
- **Save custom Actions workflows** — new standalone workflows initialize their
  name from validated YAML, so valid starter workflows can be saved after setup.
  Missing names, runners, files, source validation or access settings now have
  inline guidance that leads back to the relevant control or editor. Repository
  setup also offers a direct custom-workflow option.

### Cloud and webmail recovery

- **Continue app installs and plan selection after sign-in** — app and plan links
  retain their destination through login, registration, verification, password
  reset and 2FA. App installation resumes its confirmed configuration, server and
  existing draft after checkout; failed retries remain recoverable. Plan links
  select an offer for review, with an explicit action still required to purchase.
- **Reconnect saved Cloud server links** — disconnected links show a Cloud sign-in
  action, with separate guidance for account mismatches and temporary failures.
  Live controls wait for a verified connection, and reconnecting reuses the saved
  server link. Controls missing from an older Cloud API show availability guidance;
  refreshing retries reads without repeating a write.
- **Recover an existing webmail app** — when a mail registration loses its webmail
  link, select an accessible existing app on the same mail server and hostname and
  choose **Reconnect and deploy**. Recovery reuses the project, credentials and
  persistent volumes while preserving domain ownership and permission checks.

### Runtime configuration and deployment safety

- **Select matching runtime versions and custom production images** — generated
  PHP builds support PHP 8.3 and 8.4 through the generic `runtimeVersion` setting.
  Docker source builds offer an advanced `runtimeImage` override. Stack-selected
  recipes validate actual runtime capabilities and compatibility before activation;
  invalid settings do not partially update the project, and retained-image rollback
  preserves the original version and image configuration.
- **Recover Cloud Actions from connected instances** — Desktop and self-hosted
  clients forward Cloud workflow and runner operations to their owning Cloud
  instance, with the same scope and permission checks.
- **Use the server's actual available build capacity** — automatic Cloud builds
  account for running workloads and pending CPU reservations before choosing
  their worker size. Build setup also reports the effective workspace capacity.
- **Recheck deployment health** — project status and workload selection reuse
  current startup-health verification while retaining earlier warnings for review.
- **Track current container images during Compose redeploys** — cached Docker
  inventory preserves immutable image identity, so port preflight and rollback
  can verify running services safely.
- **Receive live inbox changes** — webmail refreshes after IMAP IDLE events, with
  event streams flushed through buffering proxies and correct folder routing.
- **Simplify the project Backup page** — the existing project header supplies
  its title, removing the duplicated backup heading and description.
- **Validate declared runtime roles** — stack-role configuration rejects missing
  kinds, empty commands, incomplete exec probes and invalid replica counts.
  This is configuration/detection support for future role execution.

- **Preserve domains that route only specific paths** — migrations now discover
  and retain domains with exact or prefix routes and no catch-all service. OpenResty
  and Cloud routing preserve those paths; unmatched requests return 404. Omitting
  an existing source catch-all requires a decision before project creation or
  source container changes. Routing retries keep the previous complete table when
  a selected upstream is unavailable.
- **Refresh deployment images before replacing services** — manual Docker
  redeploys refresh mutable registry tags while preserving locally built images
  and pinned rollback artifacts. Full redeploys keep otherwise unchanged external
  services, including databases, running when their actual image content matches.
  Docker validates every replacement image and freezes its reference before
  activating any service; failed preparation leaves existing containers running.
  Image preparation is all-or-nothing, while container replacement remains
  sequential rather than a transaction across the whole stack.

## 0.9.0

Openship Actions brings repository CI to your own Linux and macOS servers and
Cloud runners. This release also lets you move your Openship control plane between
Desktop and a server, adds GitHub deployment Checks and shared notifications, and
improves Cloud build scheduling, routing, monitoring and webmail. These notes cover
all changes since 0.8.2.

### Openship Actions

- **Run CI independently of GitHub Actions** — workflows in `.openship/workflows/`
  use GitHub-style YAML and run through Openship on selected destinations. Trigger
  them manually, on repository pushes or pull requests, on schedules, through
  authenticated dispatch, or from Jobs. GitHub can provide source, events and
  commit Checks without running the workflow itself.
- **Use existing GitHub workflows with Openship runners** — workflows in
  `.github/workflows/` keep GitHub's orchestration, secrets, environments and Checks.
  Register official runners on Openship destinations and target their self-hosted
  labels. Jobs targeting GitHub-hosted labels still run on GitHub; importing a
  workflow does not silently change its execution platform.
- **One workflow editor** — import multiple workflow files from a repository or
  create a standalone workflow. Topology, list and YAML views share the same draft.
  Connected job and step nodes, inline step editing, per-file trigger rules, branch
  controls and repository-change review keep setup in one flow. Repository sync
  can apply updates automatically or wait for confirmation.
- **Reusable workflows and advanced jobs** — local and authorized remote reusable
  workflows support nested calls, typed inputs, secret forwarding and outputs.
  Dependencies, matrices, expressions and job permissions use the pinned execution
  engine rather than a second shell-only workflow implementation. Unsupported
  constructs return explicit errors instead of being silently skipped.
- **Choose runners by verified capabilities** — destinations report operating
  system, architecture and available tools. Linux runners support container images
  and explicit QEMU setup for supported cross-architecture execution; macOS runners
  use native tools. Runner labels and job images are separate settings. Create a
  runner from the shared server picker without leaving workflow setup.
- **Review access before execution** — workflow access can be limited to your
  account or selected repository users, with approval required for each attempt.
  Approvals bind the actor, commit, attempt and destinations. Fork code is blocked
  by default; explicitly approved fork execution uses disposable Cloud runners
  without privileged secrets or write credentials. Work never falls back to an
  unselected control-plane host.
- **Follow runs without losing your place** — expandable jobs and steps sit beside
  masked logs, with a topology view and a separate approvals tab. Waiting work has
  visible progress; selection and log position survive refreshes. Independent runs
  stream logs in Openship. GitHub-coordinated runs link to live GitHub logs and
  import completed logs.
- **Artifacts, caches and OIDC** — independent workflows support artifact/cache
  actions through scoped storage access and configured backup destinations. Jobs
  with `id-token: write` can request short-lived Openship OIDC tokens from an HTTPS
  instance. Identity providers must explicitly trust the Openship issuer; these
  are not GitHub-issued tokens. Signing keys travel with instance moves.
- **Know the boundaries** — independent execution does not implement GitHub
  protected environments or attestations. Windows runners and GitHub Enterprise
  Server are not supported. A fresh independent run does not resume or replace a
  failed GitHub run. Native runners and runners with a host Docker socket execute
  trusted code with that server user's access; use disposable VMs for stronger
  separation.

### Cloud Actions destinations and funding

- **Reuse a server or add one** — Actions can use an existing authorized Cloud
  server pool or a dedicated managed server purchased through the normal catalog.
  These use the server's existing capacity and billing.
- **Temporary runners per job** — prepaid Actions profiles provide Linux VMs with
  2 vCPU / 4 GiB RAM / 40 GiB disk, 4 / 8 / 80, or 8 / 16 / 160. Executable jobs
  provision a temporary VM and remove it after cleanup; queued work allocates no
  VM. Temporary runners use a separate prepaid balance covering provider compute
  and transfer charges, rather than an application's monthly server allowance.
- **Funding and recovery** — $5, $20, $50 and $100 top-ups use hosted checkout.
  Provider-confirmed payment funds the runner budget; duplicate receipts cannot
  grant credits twice, and background recovery continues if the browser closes.
  Setup failures retain paid credit for retry. Pricing and estimated minutes use
  the provider's current tariff, not guaranteed fixed minutes.
- **Cloud operator setup** — temporary-runner purchases require enabled Cloud
  billing, provider credentials and live pricing. Regular-server PAYG purchases
  remain disabled. Verify a real paid Actions top-up before enabling the purchase
  flow for customers; automated payment recovery tests and live VM execution do
  not replace that checkout test.

### GitHub Checks and notifications

- **Deployment Checks enabled by default** — repository-backed deployments can
  publish project/environment results and individual service Checks, including
  deployment failures. Configure the selected Checks and their names or disable
  reporting from project settings and the project wizard, in self-hosted and Cloud
  installations.
- **Checks setup shows actual access** — workflow setup displays the connected
  GitHub account, repository and access status, with inline connect, review and
  retry actions. Independent reporting requires a GitHub App with Checks write
  access; a personal token or CLI source connection alone does not grant it.
- **Add notification channels inline** — create a channel using the shared
  Settings form, send a test, then select it without leaving the workflow.
  Unverified channels remain unselected until verification succeeds. Completion
  notifications cover selected outcomes with durable delivery and retry.
- **One notification editor** — instance defaults and project overrides use the
  same channel controls. Failed preference reads show an error and retry rather
  than editable empty defaults; account switches discard stale settings.

### Desktop connections and instance moves

- **Move control to a server** — Settings → Instance can deploy an API-only
  instance for Desktop access or an API and dashboard for browser access. Select a
  connected or managed Cloud server, configure its address and review the move.
  Projects, users, server connections, credentials, history and settings transfer
  together while application workloads remain on their existing servers.
- **Move back using the latest data** — a connected Desktop can receive the
  current remote instance, including changes made on the server. Existing hosted
  instances can also move to Desktop. Both ends verify compatible versions;
  interrupted transfers retain a journal and recovery snapshot and can resume
  without activating two controllers or reverting to stale local data.
- **Connect without moving data** — enter an existing instance URL and sign in,
  or use a short-lived connection code from your signed-in account. Desktop
  connects to that instance with your permissions; returning to the local instance
  resumes its separate data.
- **Invitations open in Desktop** — team invitations offer email delivery through
  the configured mail service or a copyable, recipient-bound link. Links open
  Desktop when available, with a manual URL fallback. Recipients sign in and
  review the instance, workspace, inviter and role before accepting. Team and
  webhook settings link to the same hosted-instance setup when a public control
  plane is required.

### Managed Cloud servers, builds and hosting

- **Manage server access in one place** — managed server tabs expose settings,
  boot logs, SSH access, temporary credentials, Runtime API token reveal/rotation
  and manually managed workloads. Outbound internet and hostname allowlists use
  revision checks and preserve unrelated ingress, routes and private networking.
- **Durable build admission** — explicitly submitted builds queue against their
  selected server's saved offer and available resources. Different projects can
  build concurrently when capacity allows; the same project's builds remain
  serialized. Queue position, waiting reasons and upgrade actions are visible.
  Image-only deployments do not reserve a source-build slot.
- **Saved plan allowances** — new Hobby, Starter, Pro and Scale offers enforce
  project/app, running-service and build-admission ceilings. Existing purchases
  retain their saved terms. Physical CPU, free memory and host headroom can admit
  fewer builds than the plan ceiling; explicit resource requests are not silently
  reduced. These Cloud quota gates do not apply to self-hosted servers.
- **Recover interrupted builds safely** — durable activity ownership coordinates
  builds, backups and server maintenance across controllers. Capacity is released
  after tracked commands and Docker-owned BuildKit workers are confirmed stopped.
  Crash recovery settles interrupted deployment state before acknowledging its
  execution, preserves live releases and retries failed recovery writes.
- **Static sites default to Cloud Pages** — build on the selected managed server
  and publish the static output without retaining an application container. Choose
  Managed server hosting when an nginx container is preferred. Each release saves
  its hosting choice for rollback; failed publication preserves the previous site.
  Backend applications keep their server runtime even when static assets exist.
- **More reliable application startup** — generated Node images respect declared
  Node requirements and explicit image pins. Managed public Node listeners can
  adapt loopback bindings without exposing private listeners. Cloud verifies
  startup before reporting container deployments ready and surfaces crash details.
- **Consistent package managers** — generated npm, pnpm, Yarn and Bun builds honor
  explicit versions, supported lockfiles and monorepo parent settings, then verify
  the executable actually used. Private catalog services retain private access;
  public services use their selected domains. MinIO installation and required
  catalog setup are more reliable.

### Deployment, routing and monitoring fixes

- **Choose another port explicitly** — when a host port is occupied, deployment
  review can suggest a free alternative and let you confirm it. Existing ports do
  not change silently. Bare redeployments recognize their own previous release,
  and private service port access binds to localhost.
- **Keep routing state consistent** — route repairs update the banner and route
  cards together, retain repair logs across refreshes and reconnect interrupted
  streams. Proxy overrides validate target capabilities before saving and preserve
  existing configuration when unsupported.
- **Verify Cloud HTTPS at the serving edge** — custom-domain checks validate the
  publicly served certificate, hostname and chain rather than relying only on
  provider metadata. Scheduled checks use bounded work and failure backoff;
  unavailable observations stay unknown instead of becoming successful results.
- **Distinguish connection loss from request failures** — an API request error no
  longer marks unrelated services offline. Monitoring retains meaningful last
  observations, reconnects dropped streams and offers retry for failed reads.
  Terminals remain usable when status reads fail.
- **Deployment outcomes in Monitoring** — projects show completed outcomes and
  failed deployments alongside application monitoring. Project cards, grids and
  backup history use more consistent spacing and responsive layouts.
- **Build and runtime correctness** — preserve Dockerfile startup defaults,
  native service source precedence, case-sensitive manifest names and monorepo
  Docker build-context metadata. Compose projects keep service detection on
  redeploy. Exec cancellation reliably reaps watchdog timers, including BusyBox
  hosts. Cloud cleanup follows the saved keep-resources policy. Shared storage
  removal keeps Longhorn's bounded native retry for an uninstall startup cache
  race and waits for confirmed completion before cleanup.

### Diagnostics, CLI, SDK and webmail

- **Structured error reporting** — API boundaries, authorization failures,
  deployments, jobs, streams and dashboard errors share a classified, redacted
  event format with request references and bounded asynchronous delivery. Cloud
  stores sanitized events in its own database. Automatic collection and upload
  remain disabled for Desktop, self-hosted installations, native workers and CLI,
  including Desktop connected to Cloud; operational errors still have local logs.
- **Broader automation coverage** — native and remote SDK operations cover Actions,
  instance connections, managed server controls, migrations, mail and terminals.
  The CLI shares platform contracts, expands Cloud and remote operations, accepts
  `/api` paths and positional environment pairs, and guides users to login on
  authorization failures. Actions are available through `openship api`; this
  release does not introduce a dedicated `openship actions` command group.
- **Updated documentation** — Actions setup, independent versus GitHub execution,
  runner access, Cloud funding, instance moves and API/SDK/CLI/MCP references cover
  the new flows, with live execution verification records.
- **Webmail improvements** — editable email signatures apply in the composer;
  replies include the original message body. Sign-in recovery and managed
  deployments are fixed. Cloud shows mail availability before loading unsupported
  server controls; Desktop and self-hosted mail remain available.
- **Additional compatibility fixes** — preserve cookie encoding in dashboard
  server requests, complete partially applied instance-controller migrations,
  filter invalid custom app templates, and add Farm.js configuration support and
  its square icon. Whole-instance recovery rebinds the imported local administrator
  atomically, preventing project reads from failing after a database wipe.
- **Release verification** — required gates cover real Linux and macOS Actions
  execution, instance moves, Docker deployment/rollback, scaling and shared
  storage, HTTPS, database upgrades and installed SDK packages. Failed release
  work can resume with verified successful checks and notarization checkpoints.

### Updating

Desktop 0.8.2 users can use the built-in updater. **Desktop users still on 0.8.0
or 0.8.1 must download the [0.9.0 installer](https://github.com/oblien/openship/releases/tag/v0.9.0)
and install it manually once.** Quit Openship and replace the application; keep
application data to preserve projects, servers and settings. The server/CLI
update path does not require this desktop recovery step. Update the API and
dashboard together; instance moves require compatible versions at both ends.

## 0.8.2

### Desktop update recovery

**Desktop users on 0.8.0 or 0.8.1: please install this update manually once.**
The built-in updater in those versions can fail with **"Redirect was cancelled"**.
Download the installer for your operating system from the
[0.8.2 release](https://github.com/oblien/openship/releases/tag/v0.8.2), quit Openship,
and replace the installed application. Keep your application data: your local
projects, servers and settings are preserved. Subsequent desktop updates use the
fixed downloader.

- Fixed GitHub release redirects in the desktop updater while retaining trusted
  download hosts, SHA-256 checks and publisher signature verification.
- Added a real Electron download test to the existing CI and release test gate,
  covering installer and proof redirects, blocked destinations, redirect loops,
  cancellation and incomplete-download cleanup.
- This redirect bug affects the desktop installer updater. The server/CLI update
  path is separate and does not need this manual recovery step.

## 0.8.1

Openship Cloud now runs projects on managed servers with their own monthly plans.
Share a server across applications, add another when you need it, and manage your
Cloud resources alongside local projects from desktop or self-hosted Openship.
This release also adds passkeys, authenticator 2FA and a private support inbox,
expands CLI automation, and improves billing, migration and deployment recovery.

### Managed Cloud servers

- **One server, multiple projects** — each managed server has its own subscription
  and shared CPU, RAM and disk. Builds, applications, Compose stacks and catalog
  services use the existing Docker and Bare deployment engines. Creating a project
  no longer allocates a separate VM or reserves another disk (#1036).
- **Choose Docker or Direct execution** — use Docker for containers and Compose,
  or run compatible source applications as supervised host processes with Direct.
  The shared destination picker can select an existing server or start a purchase
  for another. New eligible source apps default to Direct below 2 GiB RAM; saved
  projects and explicit runtime choices are preserved (#1064).
- **Use the capacity you purchased** — a service can use the server's full
  available CPU and RAM, or use a custom container limit. Fractional CPU settings,
  including Micro, reach Docker correctly. Source builds use available server
  headroom and optional build caps; image-only installs do not start a source
  builder. Applications, builds and the operating system still share the host.
- **Inspect usage separately from capacity** — server monitoring distinguishes
  the purchased disk size from measured usage. Project containers and volumes have
  a disk breakdown, with shared images, build cache and system data shown
  separately. Missing readings stay unknown, and undeployed drafts no longer
  inflate running-service counts (#1011).
- **Manage the server when you need to** — reuse server diagnostics, terminals,
  listening-port checks and resource views. Networking controls outbound internet
  access; the Activity tab holds provisioning and resize logs. Scheduled command
  jobs can target shared or separately subscribed managed servers.
- **Recover operations without losing neighboring projects** — provisioning,
  resize and interrupted deployment work retain progress for retry. Resizing
  restores previously running services while leaving intentionally stopped ones
  stopped. Project deletion removes its own resources and preserves the shared
  server; server deletion checks remaining projects and subscription state.

### Cloud accounts on desktop and self-hosted Openship

- **Your existing Cloud resources appear when you connect** — Cloud projects,
  apps and managed servers join the local inventory. A server already linked to
  the installation appears once. Cloud-owned settings, deployment history and
  operations stay in Cloud rather than becoming local project copies (#1074).
- **Buy and use managed servers from the same dashboard** — Cloud subscriptions
  and provisioning remain in Cloud. Local projects can select an authorized
  managed server through the same destination picker as SSH servers, using an
  execution link for deployment, logs, terminals, jobs and backups.
- **Account switches clear the previous account's state** — inventories, project
  details, deployment history and billing responses follow the selected Cloud
  account and organization. Connections are revalidated for live operations;
  locally scoped automation credentials do not inherit the owner's Cloud account.

### Billing and plans

- **Monthly servers include their full paid period** — new monthly plans cover
  purchased CPU, RAM and storage without a second compute-credit allowance or a
  monthly build-time cap. New offers have no project or running-service count
  limit; workloads share the server's physical capacity. Optional managed proxy
  transfer and storage retained after coverage ends remain separate charges.
- **Revised plans and Custom resources** — Hobby is $5/month for 1 vCPU, 4 GiB RAM
  and 25 GiB disk; Starter is $20 for 2 vCPU, 8 GiB and 32 GiB; Pro is $39 for
  4 vCPU, 16 GiB and 128 GiB; Scale is $99 for 8 vCPU, 32 GiB and 256 GiB. Custom
  lets you choose CPU, RAM and disk and review a quote before checkout.
- **Billing follows the selected server** — switch servers without losing the
  page, inspect each subscription independently, or use **Get server** for a new
  purchase. First-time customers see plans rather than empty usage screens.
  Smaller upgrade comparisons keep compact cards and a separate current-plan
  summary; payment methods and invoices share the server's Stripe portal.
- **Review plan changes before applying them** — show the provider's prorated
  amount, effective date and affected projects. Capacity upgrades apply after
  confirmed payment; resource reductions and billing-mode changes wait until
  renewal. Pending changes remain visible, and a resize requires restart consent.
  Disks can grow but cannot shrink in place.
- **Checkout has a visible recovery path** — payment confirmation, paid coverage
  and server readiness are separate steps. Setup failures expose progress and
  retry without asking for another purchase; the welcome dialog appears when
  setup completes. Unavailable offers show a dedicated dialog with retry and a
  support request for availability updates (#1062).
- **Resume or cancel unfinished payments** — **Pending payments** lists each
  server's saved offer and opens its original checkout. Provider-confirmed
  cancellation lets you choose another plan or delete an unused, unpaid server.
  Cloud and connected installations share the recovery flow, and switching
  accounts discards the previous account's payment details and responses (#1067).
- **Preview prepaid PAYG tiers** — compare three shared resource-pool tiers,
  configure server resources and select a credit package in one calculator. The
  estimate separates active vCPU-hours, reserved RAM and storage, with hourly
  costs and balance-duration scenarios. Enterprise contact is available in both
  purchase views. PAYG purchases remain disabled in this release (#1057).

### Account security and GitHub

- **Passkeys and authenticator 2FA** — Settings → Security supports passkey
  registration and removal, authenticator QR setup, and single-use recovery codes.
  Enabled 2FA also applies after social and passkey sign-in. These controls are
  available on Cloud and self-hosted installations with local accounts (#984).
- **Account protection remains consistent during failures** — credential changes
  commit together, concurrent requests cannot reuse a challenge or recovery code,
  and password resets do not disable 2FA. OAuth, invitation and MCP handoffs resume
  after verification. Security setup state clears when the account changes.
- **GitHub repository access is independent of sign-in** — one GitHub identity
  can authorize repositories for multiple Openship accounts without transferring
  login ownership. Reconnect existing installations from the shared connection
  flow, including direct installation links, and see completion or failure for
  each attempt (#992).
- **Personal tokens work throughout the repository flow** — Git settings remain
  reachable through the alternative connection option. A verified token can supply
  repository and owner listings and private-source access when no GitHub App
  connection is available. Account avatars and Git URL entry are clearer.

### Support and onboarding

- **A private Cloud support inbox** — submit deployment, billing, account or
  general tickets, search your history, reply and resolve or reopen a conversation.
  The same personal ticket history is available from Cloud-connected desktop and
  self-hosted installations. Team membership does not expose another user's
  tickets (#1073).
- **Support and contact pages accept durable requests** — submissions are saved
  before email delivery, with a receipt and notification to `support@openship.io`.
  Delivery retries survive API restarts, and support replies appear in the inbox
  and are emailed to the customer. Retried submissions reuse their original
  receipt rather than creating another ticket (#970).
- **Clearer first-run and account screens** — refreshed Cloud plan prompts,
  purchase welcome dialogs, email-verification and password-reset completion
  screens. The home page omits empty system-status cards for new Cloud accounts,
  and already subscribed users do not keep seeing the first-purchase promotion.

### Apps and migration

- **Apps have their own place** — a dedicated Apps sidebar entry and list keep
  catalog applications separate from source projects. Compact home rows, restored
  empty states and clickable app illustrations make discovery less cluttered.
- **A more consistent deployment wizard** — share destination and server controls
  across Cloud and self-hosted modes, with Full/Custom power choices, filled
  inputs, compact Build/Start settings, readable deployment-step icons and clearer
  draft project details. App install forms support grouped and two-column layouts.
- **App installation explains routing and resource choices** — public dashboards
  start with domain routing and ask for confirmation before continuing without a
  recommended domain. Self-hosted app CPU/RAM recommendations are advisory;
  failed Cloud installs can be retried or cleaned up without treating an absent
  runtime as a teardown failure (#1009, #1016).
- **Import Docker applications into managed Cloud servers** — reuse the existing
  migration engine for images, environment, volumes, bind data and routes. Cloud
  can connect an external SSH server as a migration-only source. Target preparation,
  saved progress, verification and explicit cutover support recovery; source data
  is preserved and source-container retirement requires consent.
- **Review imports as cards or topology** — compact expandable service cards are
  the default, with a topology view, expand-all controls, repository linking and
  clearer Custom, Free and Internal-only routing choices.

### Builds, deployments and recovery

- **Stop cancels the selected builder** — cancellation reaches the worker's
  actual Docker or Bare runtime, including remote Git and archive preparation.
  The UI shows **Stopping…** until cleanup finishes, then permits redeployment.
  Cancelling a build preserves deployed containers that inherited build labels;
  ambiguous service ownership still blocks activation (#1059).
- **Build output stays readable** — Cloud Docker streams preserve raw bytes,
  partial lines, UTF-8 characters and terminal progress updates. Uploads finish
  correctly when stdin closes. Disk and inode exhaustion are explained separately
  from memory failures, and temporary BuildKit cache is reclaimed after builds
  (#1058, #1064).
- **Unchanged Compose services stay running** — folder uploads and snapshot syncs
  no longer mark unchanged image services dirty. Import metadata preserves
  concurrent configuration edits; inherited project resource changes still apply
  while respecting per-service overrides (#989).
- **Pre-deploy backups finish before activation** — deployments wait for all
  configured pre-deploy backups and their cleanup, including when reusing a build.
  Failed backups offer retry, an explicit skip or stop. PostgreSQL dumps must
  succeed, and suspiciously small dumps are rejected against recent comparable
  backups before becoming restore points (#1060).
- **Remote builds and static releases use the right paths** — subfolder refreshes
  preserve root manifests and rescan at the project root. Static output resolves
  relative to that root, and retained artifacts are checked on their deployment
  destination for rollback. Directory-only `.dockerignore` negations are honored
  (#1010, #1041).
- **Health checks and shutdown respect the runtime** — configured single-app
  readiness probes run through the deployment server; unreachable SSH leaves a
  check unverified. Docker replacement honors stop signals and grace periods,
  probe watchdogs are reaped, and Bare services retain the correct user privileges
  and artifact ownership (#1043).
- **Farm.js detection** — identify Farm.js applications and supply the framework's
  build and output defaults (#1037).

### Domains, networking and monitoring

- **Free domains follow the selected managed server** — availability and quota
  checks retain the destination through project creation, Compose synchronization
  and deployment. Route changes are validated before related settings are saved;
  editing an existing route at the limit does not count it as a new route (#1064).
- **Connect Cloudflare from domain setup** — add and verify a DNS credential
  without leaving the DNS panel, review proposed records, then apply them.
  Cloudflare TXT quoting and Cloud certificate-status handling are corrected,
  while certificate checks verify the domain's project binding (#977).
- **More reliable wildcard HTTPS and Edge recovery** — DNS challenge hooks pass
  Certbot validation, Compose installations detect Edge correctly, and challenge
  route cleanup checks ownership. Whole-project rules handle a null path prefix
  correctly. Projects no longer have the unrelated 20-public-endpoint schema cap
  (#1054, #1003, #1017, #1045).
- **Source updates remain visible until deployment completes** — the project
  deployment tab indicates available updates; unchanged image services are not
  refreshed unnecessarily. Updates on the local Openship instance use the
  appropriate advisory flow, and resource reporting accepts current Docker
  runtime limits (#1006, #1047).
- **Connection and setup fixes** — recover Cloud Docker connections after
  credential rotation, report missing proxy/bridge failures clearly, correct
  registry TLS/WebSocket dependency compatibility, and handle Docker networks
  without subnets during cluster setup (#970, #1068, #961).

### SDK, CLI and platform fixes

- **More administration through Ship SDK and the CLI** — add commands for project
  resources, environments, storage and connections; credentials and DNS;
  monitoring, notifications and webhooks; workspace access and audit history.
  They use the shared platform operations and permission checks.
- **Safer command targeting and environment edits** — each CLI invocation keeps
  its selected endpoint, credential and organization. Directory links reject
  mismatched contexts. Partial service environment edits preserve other values
  and secret classification; full replacement is explicit. Deployment waits have
  deadlines and expose pending decisions, and request logs can be followed through
  the SDK's authorized Cloud stream.
- **Clearer MCP Cloud workflows** — discover authorized managed destinations and
  deploy desktop folders through a connected server. Explicit promotion to Cloud
  can resume from its saved receipt after an interrupted response or cleanup,
  without importing the project again (#1056).
- **Webmail and dashboard fixes** — Spam, Not spam and Archive move messages into
  the correct IMAP folders. Notification settings and icons recover from hydration
  races, Teams accepts current Microsoft webhook hosts, member-access settings
  avoid repeated refetches, and background project deletion preserves navigation
  (#981, #1004, #1008, #1035, #1024, #1066).
- **API startup and bulk-action validation** — capacity previews pass the startup
  permission scan, and malformed bulk container requests are rejected instead of
  being interpreted as an empty request (#1033, #994).
- **Optional Cloud product analytics** — the hosted Cloud API can send configured
  PostHog events for signup, deployment and verified checkout/payment outcomes.
  Delivery is queued separately from those operations. Telemetry runs only on the
  hosted Cloud API; local operations, logs, secrets and session recordings are
  excluded.

### Data transfer and upgrade notes

- **Complete, portable exports** — instance and project archives include plaintext
  environment values, server keys and credentials by default, without an export
  password. Treat the archive as sensitive or explicitly omit secrets. Imports
  still accept older encrypted archives and encrypt credentials with the
  destination's key.
- **Imports preserve scope and selected data** — instance imports default to
  full replacement after confirmation. Project overwrite removes destination-only
  records in selected categories and applies cleared credentials atomically.
  Project analytics retain normalized hostnames, including `www`; unsupported
  archive fields are rejected before changing data.
- **Upgrade Cloud before connected clients** — new inventory and support features
  require the matching Cloud API. Desktop-initiated cancellation fixes require an
  updated desktop controller. Existing per-project Cloud deployments need an
  explicit migration to managed servers; updating alone does not consolidate VMs
  or replace saved subscription terms.
- **Keep account-security configuration stable** — self-hosted passkeys require
  HTTPS and a stable dashboard hostname through `OPENSHIP_PUBLIC_URL` (localhost
  is supported for development). Retain and back up `BETTER_AUTH_SECRET`, which
  protects authenticator secrets and recovery codes.

## 0.8.0

Scale applications, PostgreSQL and Redis across your own servers, connect those
servers through private networking, and share files between application instances.
This release also adds the Node.js SDK, expands MCP automation, refreshes the
dashboard and desktop experience, and brings the deployment, environment, routing,
backup, mail and security fixes accumulated since 0.7.2.

### Server clusters and private networking

- **Connect servers across providers** — register and verify an existing private
  network or prepare an Openship-managed WireGuard network across your servers.
  Provider network groups retain their provider and network details; managed
  networking also supports custom infrastructure (#899, #900).
- **Networks and compute clusters have separate responsibilities** — the
  Networking tab owns addresses, connectivity and network operations. The Clusters
  tab groups selected servers from a private network and manages the runtime used
  by their projects.
- **Choose which servers can reach each other** — edit connections in the network
  topology, allow traffic in both directions or one direction, or remove a
  connection. Openship enforces the private-access policy on supported hosts and
  shows the provider firewall rules to apply before setup. Cluster setup checks
  that its selected servers have the bidirectional connectivity it requires.
- **Test the network from the topology** — on-demand checks verify allowed paths
  and confirm that denied directions reject new connections. Results include
  TCP/UDP reachability, MTU, round-trip latency, loss and jitter; a selected pair
  can run a bounded throughput test. Saved results remain available for diagnosis.
- **Prepare, review, retry and clean up network changes** — missing prerequisites
  can be installed automatically, address allocation and firewall requirements
  are reviewed before apply, and reconnectable progress includes per-server steps
  and errors. Interrupted work exposes explicit retry or rollback. Failed members
  can be removed from setup, and removal reverts owned network changes.
- **Prepare servers for application scaling** — self-hosted and desktop
  controllers install k3s under the hood, join the selected SSH servers, and
  verify node readiness, pod traffic, service routing and internal DNS. Saved
  progress supports retry after failure or interruption; runtime removal checks
  dependent workloads and owned infrastructure first (#912).

### Application scaling

- **Run an application or worker across your servers** — select a prepared
  cluster, publish the application's image to a shared registry, and deploy
  through the normal project flow. Set 1–100 replicas; subsequent replica changes
  reuse the active immutable image without rebuilding. Openship Edge routes
  public requests to the application, and the topology shows observed instances,
  placement and readiness.
- **Update, roll back and recover running applications** — cluster deployments
  retain image history for rollback, and failed or cancelled candidate releases
  preserve the active release. Kubernetes replaces failed instances within the
  prepared cluster and routes to surviving ready instances after detecting an
  unavailable worker. Revision checks reject stale changes to a running project.
- **Mount shared files in application instances** — project-owned shared volumes
  can be attached at configured paths, including read-only mounts. Instances on
  different servers can read and write the same files; existing node-local mounts
  require a separate data migration.

### Databases and shared storage

- **Choose standalone or clustered PostgreSQL** — managed databases have their
  own resources, progress, credentials and lifecycle. PostgreSQL clusters provide
  replicas, primary recovery, and private read/write and read-only endpoints.
  The database controller owns replication and failover independently of the
  application's replica count.
- **Run Redis standalone or as a cluster** — Redis clusters distribute data
  across shards with replicas. Grow or reduce the shard count after reviewing
  the change and taking a verified recent backup. Redis Cluster requires a
  cluster-aware client; resizing checks real cluster health and slot ownership.
- **Back up and recover PostgreSQL and Redis** — configure an eligible S3
  destination for manual, hourly or daily backups. Restore a verified archive
  into a separate database, inspect it, then explicitly replace the application's
  saved connection and redeploy. Redis archives preserve values and expiry and
  are consistent per shard, rather than one transaction across all shards.
- **Import existing databases and stage PostgreSQL upgrades** — import eligible
  Docker PostgreSQL or Redis backups while the original application remains on
  Docker. PostgreSQL 17-to-18 upgrades create a separate logical copy for checking
  before connection replacement. Source data remains available; changes after
  the captured recovery point need a fresh capture before final cutover.
- **Share files with independent disk copies** — enable shared storage on at
  least two independent servers, choose two or three copies, and create
  project-owned volumes. Inspect attachment and copy health, grow a mounted
  volume, and rebuild a lost disk copy.
- **Recover files from outside the cluster** — take manual or scheduled external
  backups and restore them into a new shared volume. Archives remain discoverable
  after deleting the original volume or removing empty shared storage; archive
  deletion is an explicit separate action.
- **Keep data when removing a database** — removal can retain its data for later
  recovery or explicitly delete it. Application, volume, storage and runtime
  cleanup enforce dependencies and ownership, so an unfinished cleanup or retained
  database cannot silently lose the infrastructure it still needs.

### SDK, CLI and MCP

- **A Node.js SDK alongside the CLI** — the `openship` package now provides
  `OpenshipClient` through `openship/client` for remote installations and
  `createShip` through `openship/native` for an embedded engine without a separate
  API server. Both use shared platform operations, validation and authorization.
  Native instances have explicit start/close lifecycles and verified workspace
  scopes; ESM and CommonJS are supported on Node.js 22 and newer (#887).
- **MCP covers more of the operational lifecycle** — networking, cluster setup,
  replica scaling, managed databases, shared files, backup/restore, migration,
  routing and diagnostics have documented tools and ordered workflow prompts. Discovery
  respects workspace permissions and instance mode; required arguments and DELETE
  bodies survive dispatch, and path arguments cannot redirect a call to another
  route. Generated API, CLI and MCP references describe the available operations
  and explicitly excluded HTTP-only routes (#953).
- **CLI workflows use the shared SDK** — native mode and remote clients share
  deployment and source handling, and Jobs now has commands for its existing
  management and execution flows. Re-login preserves custom context endpoints,
  folder uploads require explicit opt-in, project display names can be changed
  safely, and failed component installation returns a failure to the caller.

### Deployments and builds

- **Run release commands before activation** — configure `releaseCommands` in
  Build settings, `openship.json` or the project API/SDK. Commands run in order
  after building, using the candidate release's environment, with streamed logs
  and a ten-minute budget per command. Failure, timeout or cancellation stops
  activation. Single-app Docker and Bare deployments are supported; unsupported
  deployment types reject configured commands. Rollbacks skip them, and rolling
  back application code does not undo database changes (#592).
- **Completion and elapsed time survive retries and refresh** — workers retry a
  failed database completion acknowledgement without repeating deployment work.
  Cancellation records its outcome and duration atomically; late worker results
  cannot replace them. Both build views use the same persisted timing, including
  queued starts, rejected retries and terminal events (#940).
- **Rollback retention has a predictable limit** — Project → Advanced → Rollback
  history defaults to five past deployments, with active and pinned deployments
  kept in addition. Cleanup runs after deployment and retention changes, retries
  failed removals, and preserves artifacts still referenced by another retained
  release. Older history remains browsable with pagination and accurate snapshot
  labels.
- **More reliable source builds** — recursive Git submodules are fetched for
  build checkouts; Ruby builds respect declared versions and preserve Rails
  storage; PHP builds include EXIF and package assets needed by frontend builds.
  JavaScript `PORT` assignments are detected, invalid empty monorepo creation is
  rejected, and build-time service-DNS failures receive an actionable explanation.
- **Deployment errors reach the UI** — rejected submissions show the API's
  specific validation or configuration error. Build streams reconnect without
  replaying output, and successful deployments can show live service logs.
  Preview variable sets cannot be deployed onto a production project's runtime.

### Environment and Compose

- **Saved service variables stay visible** — the Environment tab reads effective
  values from Openship, including Compose values, shared project variables and
  explicit service overrides, with their sources. It remains usable when the
  server is offline. Saves update only edited rows, preserve untouched secrets,
  reject conflicting edits and remove an override by restoring inheritance
  where available (#926).
- **Compose updates apply without routine approval gates** — repository changes
  merge automatically while explicit operator overrides remain. Saved environment
  values survive omitted source keys, unresolved expressions and legacy review
  resolution. Interpolation uses current configured values instead of stale scan
  results; legacy pending reviews reconcile on redeploy (#893, #916).
- **Recover and apply environment changes deliberately** — older or migrated
  services can recover missing variables from their running container for review
  and saving, without overwriting saved values. Apply compares against the running
  service and recreates supported Docker services from their existing image,
  retaining ports, networks, mounts and resource limits. Failed startup restores
  the previous container; unavailable comparisons remain unknown, and unsupported
  runtimes direct the operator to redeploy.
- **Environment download and secret protection** — Download .env exports the
  listed values, including saved secrets, using quoting that round-trips through
  Upload .env. Inline service environment, build arguments and their saved
  deployment/Compose snapshots are now encrypted at rest; API presentation masks
  protected values and preserves them on round trips (#844).

### Migration and portability

- **Compose migration includes the domain handoff** — discovery reports existing
  proxies and matches Traefik routes through private container addresses as well
  as published ports. The wizard saves service environment and selected routes,
  prepares Edge during migration, and requests confirmation before taking over
  an existing proxy. Selected sites attach to their migrated services, existing
  certificates are reused, and unresolved routing prevents automatic source
  container removal (#905, #908).
- **Reuse a service across projects** — shared service connections retain the
  service's owner, data and connection settings instead of duplicating it. Existing
  Docker private links require separate migration when moving an application to
  a cluster.
- **Export a project's configuration, environment and credentials** — project
  settings download a portable plaintext file without a passphrase. The export
  identifies its server and Cloud dependencies; import previews the contents and
  requires explicit target mappings. Runtime data stays on its original server,
  and Cloud projects require the same Openship Cloud account. Imported credentials
  are encrypted with the destination instance's key. Configuration transfer does
  not copy runtime volumes or perform a whole-instance server cutover.

### Domains and certificates

- **Wildcard HTTPS with automatic DNS or manual TXT verification** — project and
  service domains such as `*.example.com` now open inline certificate setup.
  Connected DNS providers automate verification; manual TXT orders retain their
  progress across reconnects and controller restarts. API, SDK and MCP share the
  same start, status, check and cancel operations. Existing certificates survive
  failed attempts, and HTTPS is reported ready only after its route is active.
  Manual certificates include renewal guidance in all nine dashboard languages
  (#954).
- **Manage multiple wildcard domains** — configure wildcard domains in Settings
  and choose the domain to use during project setup (#819).

- **Routing retries reconcile saved and live state** — Retry routing checks Edge,
  reapplies project routes and synchronizes domains, with inline progress logs and
  refreshed results. Live ownership checks recover stale hostname/host-port
  reservations left by deleted or recreated projects. Repairs preserve complete
  routes and canonical endpoints when aliases are removed (#915, #922, #925).
- **Pending states explain what happens next** — domain details distinguish
  verification in progress, scheduled retry and failure, show the reason and next
  retry time, and offer a manual retry. Durable backoff prevents overlapping
  background sweeps from repeatedly retrying the same domain. An SSH observation
  failure no longer clears a working certificate or becomes a claim that HTTPS
  is absent (#911, #922).
- **Imported certificates and container routes recover correctly** — certificate
  lookup follows managed lineages and avoids collisions after import; recovery
  excludes ACME challenge ports from application upstreams. Static sites inside
  containers route through their owning service, and Edge serves an Openship
  error page for unavailable upstreams (#879, #913).

### Backups and restore

- **Back up now from the project, service or volume panel** — service shortcuts
  reuse an applicable policy and run only the selected service. Project policies
  skip stateless services and admit their eligible runs together. Progress shows
  saved phases, elapsed time and transferred bytes, reconnects across workers,
  and updates recent history even after the progress view is dismissed.
- **Optional incremental backups** — policies can reuse verified unchanged
  blocks, with a complete block index for each restore point. Retention preserves
  blocks still referenced by another snapshot, and storage totals count shared
  objects once. Full backups remain the default. Captures still scan the whole
  source and transfer through the Openship backup worker.
- **Retention and destinations remain consistent** — pruning runs after
  successful capture and through the scheduled sweep, preserving protected copies
  and backups used by active restores. Existing runs retain their original
  destination when a policy changes, and failed cleanup remains retryable without
  invalidating a successful backup. SFTP failures close streams and clean partial
  uploads instead of leaving the worker stuck (#817).
- **Restore validates before replacing data** — preparation and confirmed apply
  share source/target checks, integrity verification and exclusive access to the
  project or mail server. Runtime/stop failures abort before destructive writes;
  partial-write failures are reported and do not automatically restart a service
  on incomplete volume data. Redis/Valkey restore validates persistence settings,
  and PostgreSQL restore uses a transaction for each supported artifact. Release
  tests now exercise backup, incremental reuse, retention and restore with real
  Docker volumes and databases (#892, #946).

### GitHub and access

- **Cloud GitHub connections finish in the dashboard** — installation completion
  refreshes repository access and the connection state instead of leaving the
  page loading after GitHub has finished. Device sign-in keeps its code and
  instructions visible until completion; transient and rate-limit failures no
  longer discard durable credentials (#920, #951).
- **Repository selection stays in sync** — branches load on demand while keeping
  selection and keyboard focus, and changing the branch rescans deployment
  configuration. Partially successful push-webhook dispatches retry failed targets
  without redeploying targets that already completed (#847, #870).
- **Sign-in and invitations respect the configured flow** — clients can discover
  enabled login providers, and signed-out invitees can reach account creation and
  complete acceptance without the dashboard's prior navigation race.

### Dashboard and desktop

- **Shared icons and more consistent layouts** — dashboard and desktop use a
  theme-aware icon catalog with bundled local assets. Service headers, tabs,
  environment controls, volume forms, source settings and log controls have
  consistent spacing and typography; mobile navigation and crowded rows are
  improved (#942, #946).
- **Topology stays inside the project** — the graph has an optional expanded
  view, improved loading placeholders and compact service nodes. Clicking a node
  opens its details directly; long runtime identifiers truncate with copy actions
  rather than widening the panel.
- **Deployment pages put actions and logs first** — Open site and Open project
  remain prominent, multiple exposed domains can be selected, and preparation,
  service status and single-app steps share clearer progress indicators. Logs
  have bounded layout, search and copy controls; history filters survive returning
  from a deployment.
- **Backup pages show retained data and real run state** — global and destination
  views share paginated history, restore actions and usage information. Successful
  retained copies, active attempts and physical storage totals are distinguished;
  history remains available after policy changes.
- **Desktop startup follows the application theme** — a redesigned loading screen
  uses shared colors, clearer progress and service startup states (#952).

### Monitoring and runtime reliability

- **Monitoring recovers after connection interruptions** — desktop connectivity
  loss is distinguished from a confirmed remote runtime failure, with recheck and
  reconnection handling. Overlapping status requests no longer stop polling or
  replace newer results, and issue feeds remain available when a host adapter
  cannot start. Services show a checking state while runtime status is unknown
  (#927, #949, #951).
- **Traffic views use the same time series** — overview and monitoring render
  timestamped request buckets with clear time ranges, area/column views and loading
  skeletons. Analytics failures stay within the affected view instead of appearing
  as empty traffic or replacing fresh data with stale responses.
- **Long-running resources are bounded and released** — container log retention
  is bounded for newly created managed containers, session caches preserve active
  work at capacity, and closed log, terminal and IMAP streams release their
  subscriptions. Busy builds retain their SSH transport; abandoned terminal
  handshakes release their slots and resumed shells remain bound to the authorized
  target (#950, #951).
- **Server administration reports actionable failures** — macOS hosts expose
  system statistics, server responses match shared diagnostics contracts, and
  deletion refuses hosts with active deployments. SSH group refresh preserves
  active sessions after Docker installation.

### Cloud and API

- **Cloud billing follows the selected organization** — plans, checkout, credit
  top-ups and renewal management use Oblien namespace entitlements. Purchased
  limits survive catalog changes, deployment/recovery checks enforce available
  capacity, and checkout completion verifies payment delivery rather than trusting
  the return URL. Billing portals remain scoped to the organization (#910).
- **Standalone APIs limit unauthenticated floods** — a separate per-IP guard runs
  before authentication without consuming the route's own limit. Cloud mode or
  explicit `OPENSHIP_TRUST_EDGE=true` delegates that outer ceiling to the upstream
  proxy while preserving per-route limits (#123).

### Mail

- **Check and renew the certificates mail clients actually use** — mail settings
  show expiry and the certificates served by SMTP and IMAP, with actions to check
  and renew them. Successful renewal reloads Postfix and Dovecot and verifies the
  served certificates. Automatic renewal uses the shared scheduler; expiry,
  renewal failures and stale served certificates appear in Health and Monitoring.
  Scheduled renewal requires the Openship controller to remain running.
- **Webmail refreshes without duplicate subscriptions** — inbox updates use a
  single owned SSE/IMAP IDLE connection with cleanup on disconnect. Replies fill
  recipients and subject correctly, Trash uses IMAP deletion, and mobile composer,
  accessibility and browser-cache failures are corrected (#897, #904, #921, #950).
- **Remote-content blocking also covers CSS** — disabling remote images prevents
  CSS imports and URL-based fetches from leaking a read receipt (#220).
- **Mail setup, delivery and alerts are more reliable** — setup distinguishes an
  unverified public SMTP probe from a stopped server; database port selection
  handles conflicts; mounted certificates and Amavis state recover on restart.
  Relay TLS and SES MAIL FROM checks are corrected, delivery health evaluates the
  full queue, and captured messages remain until notification delivery is durably
  queued. Job and backup notifications include their relevant target, outcome and
  log details (#834, #865, #867, #945, #951).

### Release checks

- **Continue an unpublished release with updated code** — reuse successful whole
  checks only when their source and workflow inputs match, and rerun failed or
  affected checks. Artifact reuse verifies the original run and immutable artifact
  identity; concurrent tag changes and earlier publishing attempts prevent unsafe
  continuation.
- **Real application, database and shared-storage acceptance journeys** — release
  checks exercise MCP dispatch, image publication, deployment, public routing,
  scaling, updates, rollback, worker recovery and project cleanup. Separate
  database tests verify real queries, replica/shard changes, backups, restores,
  imports and upgraded copies. Shared-storage tests use independent Linux VMs for
  SSH installation, cross-server writes, volume growth, disk-copy rebuilding and
  external backup recovery. These heavier journeys run in the release gate or
  on demand.

### Upgrade notes

- **Scaling scope in this release** — cluster management is available from
  self-hosted and desktop controllers. Application scaling supports single apps
  and workers with project-owned shared files. Compose application scaling,
  CPU/traffic-driven autoscaling, automatic server provisioning and live cluster
  membership changes are not included.
- **Keep the database and encryption key together** — this release includes
  database migrations and converts legacy plaintext service configuration when
  the engine starts. Back up the database and retain the instance encryption key
  (`BETTER_AUTH_SECRET` for API installations) before upgrading. Downgrading to a
  version before this protection requires its matching database backup. Use Data
  Transfer with secrets included when moving configuration between instances with
  different keys.

[Full comparison: v0.7.2…v0.8.0](https://github.com/oblien/openship/compare/v0.7.2...v0.8.0)

## 0.7.2

Soft maintenance patch for Docker build reliability. No breaking API changes or
database migrations.

### Builds

- **Successful Docker builds are no longer rejected by diagnostic log text** —
  fixes a regression present in 0.7.1 where successful workspace scripts reporting
  `Exited with code 0` could fail deployment (#832). Single-image and Compose builds
  now distinguish Docker Engine errors from application output, for both classic
  and BuildKit builders. Diagnostic hints enrich real failures without overriding
  successful completion or hiding Docker's error; SSH builds continue to use the
  command's exit status. Cancellation and inactivity safeguards remain in place.

## 0.7.1

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

- **`openship.json` environment now reaches Dockerfile builds end to end** — top-level project
  variables are recovered from the trusted source, encrypted into each deployment snapshot, and passed
  through the existing shared Docker build-argument resolver for first deploys, redeploys, webhooks,
  folder uploads, and explicit single-app mode. Native `services[].buildArgs` adds per-image overrides
  (`null` inherits the matching project value), while service `env` remains runtime-only (#795).
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
- **Successful deploys no longer re-advertise stale updates** — resolving the
  tracked branch head refreshes its upstream cache while a deployment is in
  progress, and successful deployments invalidate cached upstream state before
  the UI refreshes. The update banner and issues feed therefore compare the live
  deployment against a fresh upstream version instead of an older cached commit
  or image digest (#726).

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
