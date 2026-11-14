# Container discovery through Openship Edge (Docker and Podman)

Status: parser, inspection, persistence, scanner, routing, server-domain TLS, and
upstream reachability are implemented. Continuous discovery, unavailable-vhost
retention, route repair, API/UI, and production rollout remain pending. The expanded
Docker/Podman compatibility work below is required before declaring full runtime support.

## Implementation status (updated as code lands)

- **Step 2 — base implementation landed; runtime compatibility expansion pending.**
  Core parser: `packages/core/src/discovery-config.ts` (41 tests) — upstream
  candidates model landed: bridge-ip and published-port (exact declared TCP
  port) candidates in deterministic order; selectors fully validated
  (missing/unusable/ambiguous); zero-bridge + published binding is the
  rootless path. Runtime view: `getDiscoveryContainerView` +
  `discoveryContainerViewFromDockerInspect` in `packages/adapters/src/runtime/`
  (+7 tests incl. a Podman-style inspect fixture) with publishedPorts
  extraction, `discoveryInspection` capability, `listAllNetworks` on the
  adapter interface. View feeds the parser directly. Edge-context reachability
  now selects from fresh candidates before activation. More runtime payload
  fixtures and the production canary remain required.
- **Step 3 — persistence DONE, API layer NOT started.** Schema:
  `packages/db/src/schema/discovery.ts` (`discovery_settings`,
  `discovery_binding` incl. upstreamStrategy/hostPort/hostIp, withdrawalPending,
  containerRunning, blocked apply state), `domain.serverId` for
  ownerType='server'; migration `drizzle/0224_server_discovery.sql`
  (hand-written; still undeployed anywhere, so in-place amendment remains
  valid — if any instance applies it, switch to append-only). Repo:
  `packages/db/src/repos/discovery.repo.ts` (34 PGlite tests; also validates
  the migration): observation upsert requeues on config OR runtime-target
  changes (container id/IP/running/strategy/host port), invalidation via
  markInvalid, removal queues withdrawal, apply backoff, block/unblock,
  dueForWithdrawal/markWithdrawn. Issuance eligibility:
  `serverVerificationOwner` inside `liveVerificationOwner` in `domain.repo.ts`
  (requires discovery enabled + an observed, RUNNING, unsuppressed binding;
  fresh re-inspection still gates every ACME order). Dump catalogue: both
  tables instance-scoped. Not done: contracts schemas, platform operations
  (configure/preview/status/suppress/forget with server access policy),
  controller + routes.
- **Step 4 — base scanner landed.**
  `packages/platform/src/engine/modules/discovery/discovery-scanner.ts`
  (covered by scanner tests): inventory → bounded inspect → parse → observe; duplicate LIVE
  (running) identities block all candidates — a retained stopped container
  never blocks its running replacement, and stopped-only duplicates are
  visible without route risk; other-owner hostnames block;
  `applyState='blocked'` never auto-retries (unblock is explicit/conflict
  resolved); inspect failures leave bindings unclassified; INVALID
  declarations preserve the binding but INVALIDATE the stale observation
    (new 'invalid' observation state; container id/IP/running cleared, metadata
    retained) and queue upstream withdrawal; the parser resolves identity first
  and carries the serviceKey, so a recreated container with a new id and bad
  config is linked back to its binding and STAYS linked after the container
  id is cleared (identity match, id-independent — no missing-flip churn on
  later sweeps; only explicit opt-out withdraws); confirmed removals go
  missing AND queue route withdrawal (crash-safe; idempotent across sweeps); retirement is scheduled independently of
  blocking via `withdrawalPending` + `dueForWithdrawal()`/`markWithdrawn()`
  (applied → blocked → missing still retires the live route; blocked
  suppresses only forward applies); runtime-target changes (replacement, IP,
  stop/start) requeue an applied binding so routes never keep a stale
  upstream; unchanged rescans converge.
- **Upstream probe.** `packages/adapters/src/system/edge-upstream-probe.ts` +
  the reconciler's `resolveReachableDiscoveryUpstream`/`resolveUpstream`
  wiring landed (probing from the Edge execution context before activation;
  strategy flips requeue via observe). DockerEdgeExecutor.exec now ENFORCES
  the caller's timeout at the executor level — ONE deadline races EVERY async
  phase (exec creation, start, output wait, each inspection, and edge-down
  DIAGNOSTICS on both the refusal path and the completed-command exit path,
  which fall back to the original error when they stall — ONE absolute
  deadline spans execution and diagnostics, so slow execution leaves only the
  remainder for diagnostics) with
  phase-named rejections (each reporting the caller's REQUESTED timeout, not
  the drifting remaining budget) and demux-stream destruction on expiry — so a
  stalled daemon or exec stream in ANY phase cannot hang reconciliation.
- **Step 4 — scanner, route reconciler, server-domain TLS, reachability, unavailable-vhost retention, and record-based route repair landed; sweep/watcher WIRING (step 5) pending.**
  Unavailable-vhost retention: `UnavailableRouteConfig` in the adapter route
  union — `return 503;` with the TLS blocks and both ACME challenge locations
  kept, sidecar-stored, so `reapplyStoredRoutes` replays it and a later
  `targetUrl` registration replaces it (the resume path). Retention is decided
  by DURABLE APPLICATION HISTORY — `shouldRetainUnavailableVhost`:
  `appliedGeneration > 0` retains, unless suppressed/blocked (explicit control
  always retires fully). Normal stop/removal observations requeue applied
  bindings as applyState "pending", so the apply state cannot be the gate; the
  reconciler's withdrawal loop (markMissing/markInvalid flag
  withdrawalPending) and apply loop both retain on that predicate, and a
  PGlite flow test drives observe→apply→stop→markMissing through the real
  repo. Route repair (`discovery-repair.ts`) NEVER writes a serving upstream:
  stored IPs/ports are not validated by repair and after downtime may belong
  to another container — it restores missing route files as the unavailable
  vhost only, and switches a still-SERVING vhost whose stored backend the
  record says is dead to the retained form. Comparison is ACTUAL vs record
  via the new `routing.readRouteState` probe (sidecar state; unreadable →
  reported, never clobbered) INCLUDING the target URL: a serving vhost whose
  URL differs from the recorded upstream is STALE and is queued (not written).
  Serving routes come exclusively from guarded reconciliation (fresh probe +
  ownership + assertCurrent): whenever repair restores a 503 while the record
  describes a RUNNING backend — or detects a stale serving target — it queues
  the guarded pass via the new generation-safe `requeueForApply` repo
  primitive (row-locked and strictly conditional: expected generation +
  still-applied + still-unsuppressed, so a scanner block or operator opt-out
  between repair's snapshot and the write is never overridden; the bump
  invalidates in-flight applies; skipped for already-queued pending/error
  bindings). A restored 503 for a dead backend is NOT requeued (reconciliation
  would only re-retain). CRASH-SAFETY: an EXISTING unavailable vhost whose
  record describes a RUNNING backend is queued too — a previous repair may
  have written the 503 and died before its requeue committed. Repair never
  probes live, never touches claims, never orders a certificate.
  Sweep/watcher wiring is step 5.**
  `packages/platform/src/engine/modules/discovery/discovery-reconciler.ts`
  (+7 tests): withdrawals first (blocked/suppressed owners included), then
  due applies — bridge-ip registers `http://<ip>:<port>`; published-port
  routes through the loopback ownership guard (ObservedLoopbackPublish from
  the inspect, stable FK-free claim owner `discovery:<bindingId>`, target
  lock + strict edge inventory, no allocator); missing/invalid/stopped
  bindings get removeRoute with domain/cert metadata retained;
  markApplied(generation) only after the edge write; failures persist
  markApplyError backoff (30s→30m). Server-scoped Edge resolution via
  `resolveDiscoveryEdgeTarget` (resolveServerExecutor → platform →
  hostPortTarget, held + disposed per pass).
- **Upstream reachability implemented.** `NginxProvider.probeUpstream()` uses the
  routing provider's existing Edge executor, so remote/containerized checks run
  where OpenResty dials. A bounded Python TCP connect (Python is supplied by
  certbot in the Edge image) sends no application HTTP request; bare-local Edge
  uses the existing native TCP probe. Executor failure never falls back to the
  control plane's namespace. Only concrete engine-observed IP/port candidates
  are probed, with a six-candidate cap per apply.
  `discovery-upstream.ts` re-inspects running state, stable identity, declaration,
  and exact network/published-port candidates, then tries reachable targets.
  Wildcard published binds resolve to a loopback candidate that must pass the
  Edge probe; specific bind addresses are preserved. No reachable candidate
  means an unapplied route with persisted retry/error state.
  A generation-checked repo write persists the resolved target; final live
  inspection runs before registration (inside the host-port lock for published
  routes). The scanner retains a still-observed resolved fallback so subsequent
  sweeps do not replace a working published port with an unreachable bridge IP.
  Focused tests cover provider execution context, real TCP execution, rootless
  published-only views, fallback, stale identity/bindings, and stable rescans.
  Local live evidence: Podman 6.0.2, rootless Netavark, isolated backend on a
  private bridge and a separate host-network probe container using the actual
  provider implementation. Bridge TCP timed out, its observed loopback publish
  connected, stopped backend was refused, and restart resolved the new bridge
  observation back to the working published endpoint. An additional explicit
  `pasta` run verified published-only discovery with no bridge candidate, stopped
  refusal, and successful restart. Temporary containers/networks were removed.
  This validates namespace
  selection/probing, not a full production OpenResty/TLS deployment.
- **Server-domain TLS LANDED.** domain-ssl.ts: new 'server' SSL owner —
  authorization via the serving server row (projectId callers refused,
  serverId scope enforced), issuance on that server's edge with the per-box
  ACME lock scope, no project lifecycle locks. Every new ACME order gates on
  a FRESH container inspection under the issue lock
  (`DiscoveryBackendUnavailableError` defers stopped/unreadable backends —
  retained certificate state, never a failure record); ACME success flips the
  row verified (`markServerDomainVerified` — ACME-as-verification, no TXT).
  ssl-scheduler: renewal sweeps include server domains (cloud management
  access via the server row; gate defers skip cleanly; notifications carry
  server/binding context). Reconciler: ensureServerDomain on apply + immediate
  certificate reconciliation after start/replacement (reuse comfortably valid;
  issue missing/due; defer on stop). findPendingVerification excludes server
  domains (TXT would fail by design). Issuance retry: findPendingServerIssuance
  finds up failed first issuances (unverified, no expiry — invisible to the
  other queues) into the renewal batch with allowUnverified (round-robin
  fair-merged with the expiring queue so a full expiring batch cannot starve
  retries; cross-queue duplicates dedupe); deferred orders (stopped backend,
  disabled discovery) ADVANCE the entry's scheduling state via
  recordSslDeferred so it rotates to the back of the queue instead of pinning
  the head; every ACME order
  path (provision AND renew) runs the fresh-container + discovery-enabled gate
  INSIDE the per-box ACME lock, immediately before the order. STILL NOT DONE:
  API/UI (steps 3/6); live Podman canary
  (step 7/8). [Retention, route repair, and sweep/watcher wiring LANDED — see the
  Step 4 entry above.]
- **Step 5 — sweep/watcher wiring LANDED.** `discovery-sweep.ts`: ONE
  minute-cron system job (`discovery:sweep` via scheduleSystemJob, job_run
  history) runs scan → reconcile → repair per enabled server, per-stage
  error-isolated, honoring per-server `sweepIntervalSeconds` for the SCAN
  only. `startDiscoverySweep` runs the STARTUP INVENTORY immediately (fresh,
  fire-and-forget) and wires from API startup (self-hosted).
  `discovery-watch.ts`: lifecycle-event ACCELERATOR — events coalesce (1.5s
  debounce) into one single-server sweep; the watcher never classifies;
  subscriptions lease (150s), renew from the sweep, and self-expire via
  timer; onClose re-arms on the next tick (the 60s cadence is the backoff);
  unsupported streams run poll-only. Serialization: EVERY trigger (startup,
  cron, event) enters ONE per-server queue — scan→reconcile is a
  read-modify-write cycle and an overlapping older pass could withdraw or
  replace a newer route. Fresh inventory: startup, events, and reconnect
  arming sweeps pass `fresh: true` (only the recurring poll is interval-
  gated). Closed watchers drop their instance with the stale expiry timer
  cleared and runtime disposed, guarded by INSTANCE IDENTITY so a stale
  timer can never drain the re-armed replacement.
  `fenceDiscoveryWatchers()` from API shutdown (before job runner/SSH/db
  close) fences renewals and drains everything — and the fence is RECHECKED
  after a watcher's awaited setup, so a shutdown racing a sweep's renewal
  drains the just-built subscription instead of registering one live watcher
  with an undisposed runtime. The sweep queue's cleanup observes both
  outcomes (then(onFulfilled, onRejected), never a discarded run.finally), so
  a failing pass rejects only through the caller's catch — no unhandled
  rejection. Tests: sweep 18, watch 15. API operations LANDED:
  `packages/platform/src/discovery.ts` kernel operations (configure with
  server-access checks — status read, rescan/suppress write, configure/forget
  admin) over `@api/discovery` routes (`GET/PUT
  /api/discovery/servers/:id/discovery`, `/rescan`, service
  suppress/unsuppress/forget). Rescan enters the SAME serialized per-server
  queue with fresh inventory. Suppress schedules outright route retirement
  (withdrawalPending on applied history; unsuppress reverts a pending one);
  disable schedules retirement for every applied binding — the reconciler's
  withdrawal stage is the one stage that runs for disabled servers, removing
  outright (never 503-retained) — and the sweep iterates SWEEPABLE servers
  (enabled ∪ owing-withdrawals) with watchers renewed for enabled only.
  Forget retires the route synchronously BEFORE deleting the binding (edge
  down = retryable error, binding intact); the domain row and certificate
  material survive. Tests: repo 45 (suppress/unsuppress/withdrawal
  scheduling, sweepable servers), reconciler 19 (disabled-server full
  retirement), operations 8 (authorization strength, TLS join, disable
  scheduling, rescan shape validation, forget ordering + retryable failure).
  Follow-up hardening: FORGET runs the whole retire+delete sequence INSIDE
  the server sweep queue (runInServerQueue — the queue generalized for
  operator mutations), so an in-flight reconcile can never recreate a route
  between removal and row deletion; DISABLE is ATOMIC (repo
  disableAndScheduleWithdrawals commits the settings flip and withdrawal
  scheduling in one transaction — a crash between them would strand live
  routes on a server no sweep selects); UNSUPPRESS cancels only
  SUPPRESSION-specific retirement — withdrawals owed to server disable or
  observed loss survive the change of heart (row-locked reason check), and a
  BLOCKED binding's retirement (conflict/removal policy) survives too, as
  does the withdrawal of a row that was never actually suppressed (an
  unsuppress requires evidence of a real reversal). FORGET reads the binding
  INSIDE the queue (a queued scan can change the hostname before the task
  runs — reading outside would retire a stale hostname and strand the new
  route), and DISABLE is queued as well (an already-started FIRST route write
  must record appliedGeneration before withdrawal scheduling, or its binding
  would be excluded from retirement).
  Tests: repo 45, reconciler 19, operations 11, sweep 20 (queue serialization
  with operator mutations + rejection-safe cleanup).
  Remaining: server UI, live Podman canary (7/8).
- **Review acceptance check.** After `markInvalid()` clears `containerId`, a
  repeated scan must continue matching the rejected declaration by stable identity
  and retain `observationStatus='invalid'`. Add a regression that repeats the scan;
  do not reclassify the still-present invalid container as missing or bump its
  generation again. Retirement must remain independent of forward-apply blocking.
- Known pre-existing breakage at HEAD (unrelated): platform typecheck fails in
  `modules/actions/` — `repos.actions.runnerSessionCounts` and
  `appendRunnerSessionEvents` are referenced but do not exist in the actions
  repo.

Architecture correction: discovered domains are server-scoped Edge resources.
They require neither an Openship project nor a deployment/adoption record, and
do not require a manual Openship TXT ownership check. Issuance still requires
successful ACME validation. Renewal and repair run independently of deployments.
Certificate issuance and renewal require a currently running discovered container;
stop pauses them, and start triggers an immediate certificate check/reconciliation.

## Objective and first release

Discover explicitly opted-in containers on an enabled Docker or Podman server,
register their hostname and container port with that server's Openship Edge,
and extend Openship's certificate lifecycle to support these server-scoped domains.
Compose, Podman tooling, or the operator continues to own container lifecycle.

Tonight's deployable slice includes:

- Local Linux and existing SSH-connected standalone Docker and Podman servers,
  including rootful and rootless deployments validated against Openship Edge.
- One HTTP backend port and one custom hostname per discovered service.
- Equivalent environment-variable and container-label configuration.
- An optional existing container network selector and observed published-port routing.
- Startup inventory, lifecycle-event reconciliation, and a 60-second repair sweep.
- Persistent discovery identity, status, domain ownership, and route errors.
- Server enable/disable, list/status, and manual rescan operations.
- A small server UI for the switch, discovered services, domain/TLS status, and rescan.

Follow-up work: multiple endpoints, HTTPS backends, wildcard domains, Traefik label
compatibility, middleware, TCP/UDP, Swarm, Kubernetes, and host-to-VM bridge routing
on Docker Desktop or Podman Machine. Do not claim support for additional engines
until their adapter capabilities and live Edge integration have been validated.
No automatic network attachment or proxy takeover is part of discovery.

## Docker and Podman integration contract

Use the fork's existing `DockerRuntime` and connection machinery for both engines:
Podman exposes the Docker-compatible API used by this adapter. A separate Podman
discovery implementation is unnecessary. Gate inventory, inspection, and event
features by runtime capabilities and normalized results rather than engine names.

- Resolve the same engine endpoint and execution user as the server's existing
  runtime connection. Honor its configured/mounted socket, `DOCKER_HOST`, local
  context, and SSH forwarding where supported. Do not silently switch endpoints.
- Validate rootful Podman (`/run/podman/podman.sock`) and rootless Podman
  (`/run/user/<uid>/podman/podman.sock`) connections. Extend remote socket plumbing
  if needed; an SSH login alone must not imply `/var/run/docker.sock`.
- Scope discovery to one configured engine endpoint/user per server record in the
  first release. Docker, rootful Podman, and each rootless user's Podman inventory
  are separate scopes. Do not enumerate other users or merge their identities.
  Reject an endpoint change while bindings remain active unless an explicit
  retirement/rebinding operation completes first.
- Normalize list/inspect/network/published-port responses at the adapter boundary.
  Test Docker and Podman compatibility payloads, absent fields, network drivers,
  and container-state differences; return actionable unsupported-topology errors.
- Normalize Compose identity labels from the supported Compose providers. Confirm
  the actual labels emitted by Docker Compose, `podman compose`, and the installed
  `podman-compose` provider; use `OPENSHIP_SERVICE_ID` where reliable labels are
  absent. If aliases are needed, normalize them before parsing and reject conflicts.
- Reuse lifecycle events when available. An unsupported/interrupted stream must
  leave periodic inventory operational, with reconnect/backoff and visible status.

Reference behavior: [Podman service API and sockets](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html),
[Podman networking](https://docs.podman.io/en/latest/markdown/podman-network.1.html).

## Configuration contract

Environment variables:

```yaml
services:
  app:
    image: your-app:version
    environment:
      OPENSHIP_DISCOVERY: "true"
      OPENSHIP_SERVICE_ID: "my-app"
      OPENSHIP_DOMAIN: "app.example.com"
      OPENSHIP_PORT: "3000"
      OPENSHIP_NETWORK: "frontend"
    networks:
      - frontend

networks:
  frontend:
    name: frontend
```

Equivalent labels:

```yaml
labels:
  openship.discovery: "true"
  openship.service.id: "my-app"
  openship.domain: "app.example.com"
  openship.port: "3000"
  openship.network: "frontend"
```

Rules:

- Explicit opt-in is required; absent/false means undiscovered.
- Read effective container configuration through the engine's inspect API. Compose performs
  any `${VARIABLE}` interpolation before Openship reads the container.
- Labels and env may coexist only when overlapping values agree; reject conflicts.
- Domain and numeric container port (1–65535) are required. No port guessing.
- An explicit service ID is recommended and is mandatory for standalone containers
  without Compose identity. Otherwise use Compose project + Compose service labels.
- Identity is scoped to the server's configured organization/workspace. Containers
  cannot choose an organization, workspace, or project ID through configuration.
- Resolve an explicit network by its actual engine name, not a Compose YAML alias.
  Missing membership is an error, never a fallback to another network.
- Without a network selector, direct-IP routing requires one usable bridge network;
  require a selector when several are available. Rootless networking without an
  Edge-reachable bridge can instead use the exact observed published TCP port.
  `host`/`none` modes remain unsupported in this release; `pasta`/`slirp4netns`
  must not be rejected solely for lacking a user-defined bridge when an observed,
  reachable published-port route exists. Never guess an address or a port.
- Reject duplicate live candidates for one identity; do not arbitrarily pick a
  replica. Confirm identity conflicts before mutating routes.
- Container config changes require the operator to recreate the container.
- Exclude Openship's control-plane, Edge, and build/helper containers. Initially
  exclude already managed application containers to avoid competing route owners.

## Existing integration points

- `packages/adapters/src/runtime/docker.ts`: inventory, inspect, Docker transport,
  lifecycle event stream shared with Podman's compatibility API. Discovery has a
  per-network view; add published-port normalization and topology facts to it.
- `packages/adapters/src/runtime/docker-transport.ts`: existing local socket and
  context resolution; preserve it when creating discovery runtimes and events.
- `packages/platform/src/engine/lib/deployment-runtime.ts`: server runtime creation
  and SSH transport; confirm explicit rootless socket forwarding on remote targets.
- `packages/adapters/src/runtime/docker-container-info.ts` and
  `packages/platform/src/engine/lib/upstream-url.ts`: existing per-container-port
  published bindings and upstream strategies; extract/reuse these for server
  domains without introducing a project/deployment requirement.
- `packages/platform/src/engine/modules/migration/docker-inspect.service.ts`:
  existing label-agnostic server discovery. Reuse transport/inspection primitives;
  do not invoke full migration or read Compose source files for every scan.
- `packages/db/src/schema/domain.ts`: add a server-scoped domain binding alongside
  project/mail/webhook domains. Project and service FKs remain null for discovery.
- `packages/db/src/repos/domain.repo.ts`: pending issuance eligibility currently
  uses `liveVerificationOwner`; extend its owner predicate for server domains.
- `packages/platform/src/engine/lib/routing-domains.ts`: reuse hostname conflict
  validation without requiring project ownership.
- `packages/platform/src/engine/lib/route-apply.service.ts`: canonical route writes
  to the correct serving target, including existing locking and reconciliation.
- `packages/platform/src/engine/modules/domains/project-edge.service.ts`: extract
  reusable server Edge readiness primitives from the project entry point.
- `packages/platform/src/engine/lib/domain-ssl.ts`: add server-scoped authorization
  and provider resolution; existing non-mail authorization requires a project.
- `packages/platform/src/engine/lib/ssl-scheduler.ts`: resolve server domain context
  without `projectId`, including notifications and management-access checks.
- `packages/platform/src/engine/lib/edge-vhost-repair.ts`: repair itself is already
  provider-scoped; add startup/scheduled server callers independent of deployment.
- `packages/platform/src/engine/modules/monitoring/container-events.ts`: event
  subscription/reconnect pattern. Its tracked-health-container filtering cannot
  be reused unchanged for undiscovered containers.
- `packages/platform/src/engine/lib/system-jobs.ts` and API startup/shutdown:
  repair sweep registration and watcher lifecycle.

## Architecture and server scope

```text
Server discovery enabled + assigned workspace
        |
Docker or Podman inventory / lifecycle event / scheduled rescan
        |
Inspect -> parse opt-in -> validate identity + hostname + port + network
        |
Resolve and probe upstream from Edge: selected network IP or live published port
        |
Desired discovered-service state compared with persisted observation
        |
Server-scoped discovery binding + domain record (no project or deployment)
        |
Canonical route reconciliation -> server's Openship Edge
        |
ACME validation / shared TLS jobs -> HTTPS and renewal
```

Discovered services are their own server-scoped resources, grouped by Compose
project for display only. Do not create projects, service-table rows, active
deployments, or adopted deployments to satisfy legacy APIs. Discovery exposes
route management and observations, never application lifecycle mutation operations.

Introduce one domain-target resolver with variants for existing project targets,
mail targets, existing webhook targets where applicable, and explicit server Edge
targets. A server target derives organization and management access from its stored
server record and resolves the serving Edge directly. No fallback to the API host
on a remote-server connection failure. Keep existing owner-specific behavior intact.

Extract the reusable Edge write/repair primitives below project routing wrappers.
The new server reconciler must not call a wrapper that demands an active deployment,
or fake one. Preserve provider transaction/reload behavior and domain/box locks.

Proposed additive persistence:

- Per-server discovery settings: enabled, workspace binding, sweep interval.
- Discovery bindings with unique `(serverId, stableServiceKey)`, observed container
  ID, selected network identity, desired hostname
  and port, config hash, last successful observation, desired/applied generation,
  status, sanitized error, retry state, and any user suppression/forget marker.
- Domain `ownerType = "server"`, an explicit server FK, and a discovery binding
  reference where needed. Enforce valid owner/FK combinations; do not overload
  project/service foreign keys. Workspace visibility comes from the server settings.

Determine exact columns using repository conventions in step 1. Existing projects
and domains must remain valid with discovery disabled and after application rollback.

Discovery owns only bindings it created. An existing manual or other project's
hostname is a conflict. Never repoint it based on an observed container declaration.
Do not persist complete inspected env, secrets, or raw inspection responses.

### Upstream resolution and rootless networking

The configured port always means CONTAINER port. Discovery observes existing
network attachments and host port bindings; it never publishes ports or attaches
networks on behalf of an externally managed container.

1. Inspect the selected container on the configured endpoint and require a fresh
   running observation. Validate any explicit network selector before considering
   an upstream; a nonexistent or unsupported declared network is an error.
2. Resolve the container address on the selected usable bridge. A bridge driver
   and an IP are candidates, not proof that Edge can reach that namespace. Probe
   connectivity from the actual Edge execution/network context before activation.
3. If direct-IP routing is unavailable, resolve a live TCP published binding for
   the exact declared container port. This supports rootless Podman, including
   `pasta`/`slirp4netns`, when its published endpoint is reachable from Edge.
   A valid explicit network still constrains the attachment being selected; it
   cannot authorize a different container or a sibling port's binding.
4. Prefer an unambiguous reachable loopback binding when Edge shares the host
   namespace. A loopback endpoint on a remote server is that server's loopback,
   never the API host's. Do not emit `0.0.0.0`/`::` as destinations; resolve a
   concrete reachable address according to the serving topology. Multiple
   bindings require deterministic validated selection, never first-entry guessing.
5. If neither path is reachable, preserve the binding with an actionable error
   explaining the required existing network or port publication. A stopped or
   unresolved backend receives the existing unavailable-vhost behavior.

Published-port example for a rootless service (no network selector is required):

```yaml
services:
  app:
    image: your-app:version
    ports:
      - "127.0.0.1:18080:3000"
    environment:
      OPENSHIP_DISCOVERY: "true"
      OPENSHIP_SERVICE_ID: "my-app"
      OPENSHIP_DOMAIN: "app.example.com"
      OPENSHIP_PORT: "3000"
```

The example uses `18080` only as an operator-chosen host port. Discovery reads the
actual binding from the engine. Host loopback must be reachable from that Edge
installation; a port published on the API host or another engine is not a substitute.

Persist the resolved strategy and observed target separately from authored config.
Container, IP, host port, strategy, or running-state changes must queue reconciliation.
Re-check identity/target under the existing route/host-port locks before writing.
Use existing observed-port ownership rules for these externally published bindings;
do not invoke an allocator that reserves a new host bind. A repair must never revive
a cached target without confirming the current container and publication.

### Verification and TLS behavior

- A trusted operator enables discovery for the server. A container declaration
  can request a hostname but cannot transfer an existing domain binding.
- No manual Openship TXT ownership token is required for this server-domain flow.
  Hostname uniqueness and tenant/server authorization still apply.
- Keep separate states for configured, ACME pending, certificate active, and error.
  Do not mark a domain DNS-verified merely because it has a label or env variable.
- Make server-scoped domains eligible for initial issuance without the project
  TXT gate through an explicit owner-specific policy. Existing project checks
  remain intact. ACME success establishes certificate validation.
- Provision/renew through the shared TLS machinery and existing ACME locks. Route
  the challenge through Openship Edge while the discovered container is running.
- Issuance and renewal require an enabled persisted domain binding, its serving
  server, and a freshly confirmed running container for the stable identity.
  They never require a project or active deployment. Re-check running state before
  opening an ACME order, including jobs queued before a container stopped.
- Stopped, removed, or unobservable containers are ineligible for new ACME orders.
  Retain certificate material, expiry, and retry state without treating a deliberate
  stop as a renewal failure. Unknown inspection state defers work until a successful
  inventory; a cached running flag alone is insufficient.
- A start/replacement event triggers immediate certificate reconciliation. Reuse
  a comfortably valid certificate; renew a due/expired one, or issue a missing one,
  with the existing backoff/locks. Startup inventory and the periodic sweep cover
  missed start events. Restarting never forces an unnecessary certificate order.
- An ACME order already opened before a stop may complete; do not start further
  issuance/renewal attempts until the container is confirmed running again.
- Repair runs on startup and periodically for enabled server Edge configurations,
  including servers with zero Openship deployments and stopped application backends.
- Stored-route replay repairs existing stale config; desired-state reconciliation
  must also restore a missing route/config file from durable server domain records.
- Retain an unavailable vhost with TLS/challenge handling while a backend is absent.
  Repair may restore that unavailable vhost using existing certificate material,
  but must not trigger issuance/renewal while the backend is stopped or unobservable.
  A transient inventory failure must not erase the binding or certificate state.
- Manual disable/forget explicitly controls route retirement and renewal policy;
  absence of a deployment never does. Disabled bindings retain certificate files
  but stop automatic issuance/renewal unless separately configured to retain it.
- Failed DNS, blocked ports, ACME errors, and unreachable servers are visible retry
  states with backoff; they do not require redeploying or clicking repair.

## Implementation steps and completion checks

### 1. Prove Edge integration and lock the first-release contract

- Trace domain authorization, issuance eligibility, provider resolution, scheduled
  renewal, route repair, and cleanup for every existing domain owner type.
- Record the target engine, rootful/rootless mode, endpoint/user, network mode,
  and Edge network context. Prove direct-IP and published-port reachability on
  Docker and Podman, including the fork's rootless Podman deployment topology.
- Prove a server-scoped record can issue/renew with no project/deployment while
  its container is running, pause ACME work while stopped, and resume on start.
- Prove Edge repair can restore an unavailable vhost without triggering an ACME order.
- Identify project-only owner predicates and garbage collection rules to extend
  so they retain server-scoped domain records and vhosts.
- Record the target instance, architecture, current release/image digest, test
  domain, DNS/challenge method, and deployment workflow before rollout.

Done: one test container can be represented without project/deployment records,
and a route can reach it through the existing Edge writer. If this fails, resolve the
integration before building watcher/UI code.

### 2. Add configuration parser and network-aware inspection

- Add a pure typed parser in core for env/label normalization and validation.
- Extend adapter read types to expose selected network ID/name/IP and running state.
- Add observed TCP published-port mappings, host addresses, and network-mode facts;
  normalize Docker/Podman inspection results without retaining unrelated secrets.
- Extend declaration validation to separate explicit network validation from
  upstream selection so a published-port-only rootless container can opt in.
- Resolve exactly the declared container port through the selected network or its
  confirmed published mapping; do not require network-driver enrichment for a
  published-only topology unless an explicit selector needs validation.
- Read only required fields; redact diagnostics and bound inspection concurrency.
- Test booleans, invalid hostnames/ports, conflicting sources, missing/ambiguous
  networks, stable identity, helper exclusions, and duplicate identity.

Done: deterministic normalized declarations for Docker and Podman, including
rootless published-port cases, without runtime or database mutations.

### 3. Add server-scoped persistence and preview/status API

- Add additive schema changes and repositories for settings and binding state.
- Include observed target/strategy state needed for published-port routing. If a
  prior migration has been applied anywhere, append an upgrade migration instead
  of relying on an edited historical migration; test fresh install and upgrade.
- Implement server-domain target resolution and discovery observation persistence;
  no adoption, deployment creation, or project lifecycle APIs.
- Add organization-scoped server operations for configure, preview/rescan, status,
  and forget/suppress. Respect existing server access and workspace policy.
- Preview shows create/update/conflict/remove decisions before enabling discovery.
- Add tests proving manual domains cannot be claimed and application rollback
  still works with the additive schema.

Done: observations survive restart; forgetting a service cannot delete its container,
and no project or active deployment is required by any discovery operation.

### 4. Implement idempotent reconciliation into Openship Edge

- Compute the complete desired state before making routing changes.
- Lock by serving server/domain using existing lock conventions and re-check
  generation/container identity before applying each change.
- Create/update server-scoped observations and domain binding records.
- Apply through shared serving-target Edge primitives; extend the shared TLS jobs
  and eligibility queries to accept server targets without project TXT verification.
- Register deployment-independent server repair and certificate scheduling. Gate
  new ACME orders on fresh running-container observation; do not couple unavailable
  vhost repair to certificate issuance. Validate restoration of deleted route files.
- Store pending/applied/error states independently; retry partial applies.
- Do not mark a route active merely because its database write succeeded.
- Verify upstream reachability from the serving host/Edge execution context.
- Cover rootless namespaces explicitly: an API-host probe cannot establish that
  the Edge container can reach an IP or host-loopback published port.
- Keep HTTP challenge handling available while a certificate is pending.
- An unchanged rescan performs no route reload or new certificate order.

Done: an opted-in container gets a valid HTTPS endpoint through Openship Edge,
and unrelated vhosts remain unchanged.

### 5. Add continuous discovery and replacement handling

- Watch enabled servers with initial inventory, bounded reconnect backoff, and
  cleanup on disable, server removal, or application shutdown.
- Subscribe then inventory (or otherwise close the startup scan/event race).
- Debounce events into serialized server rescans; events are hints, inventory
  is authoritative. Run a repair sweep every 60 seconds.
- Confirm Docker/Podman event payload normalization and socket-activation reconnects;
  keep the sweep running if event subscription is unsupported or disconnected.
- Replacement with the same stable identity updates its observed container/IP.
- Start/replacement immediately schedules the certificate check; stop/removal
  pauses pending issuance/renewal work. Re-check eligibility under the certificate
  lock before a queued job opens an order.
- Confirmed stop/removal immediately withdraws the application upstream; retain
  an owned unavailable vhost and its domain/certificate rather than serving a
  cached IP or published port that the engine may assign to another workload.
- A short replacement grace window may delay metadata cleanup, never permit
  routing to an unconfirmed stale IP.
- Failed/incomplete inventory retains bindings and reports an error; it must not
  classify every service as removed. A confirmed disappearance is distinct.
- Domain removal/change or opt-out withdraws only discovery-owned routes. Keep
  certificate files for reuse; schedule metadata cleanup separately.
- Disable mode cancels watchers, withdraws discovery-owned application routes,
  and retains ownership/certificate metadata. A separate freeze mode is deferred.

Done: replacement, daemon/API restart, and a missed event converge without manual repair.

### 6. Add minimal dashboard and documentation

- Server settings: enable discovery, select workspace, preview, and rescan.
- List stable service name, container, hostname, port/network, observation state,
  Edge apply state, verification/TLS state, and actionable sanitized errors.
- Show discovered services under the server; no project/deployment creation is
  needed to display or manage their domain/TLS state.
- Follow `apps/dashboard/AGENTS.md` and the shared dashboard design guide.
- Document Docker/Podman env and label examples, actual engine network names,
  rootful/rootless socket selection, direct-IP/published-port requirements, DNS,
  replacing containers to change config, conflicts, and disable/forget behavior.

Done: the operator can enable and diagnose discovery without inspecting logs.

### 7. Validate the complete feature

Run focused parser/reconciler/ownership tests, affected-package typechecks, and
the repository's required release gates. Run the following against real Openship
Edge with Docker, rootful Podman, and rootless Podman before claiming each mode:

1. Compose service using env and standalone service using labels.
2. Domain with no Openship TXT verification/project/deployment -> HTTP challenge
   -> valid HTTPS certificate and response.
3. Repeated scan -> no duplicate rows, proxy writes, or certificate orders.
4. Container recreation/IP change -> same identity and new reachable upstream.
5. Backend stop/removal -> unavailable response; never another container's content.
6. Network selector change/missing network -> visible error and no guessed IP.
7. Domain/port change and opt-out -> correct owned-route update/withdrawal.
8. Duplicate hostname/identity -> conflict with existing route preserved.
9. Engine/API restart, Podman socket activation, and dropped/unsupported event
   stream -> automatic convergence through reconnect or periodic inventory.
10. Server inspection failure -> retained records, no mass route deletion.
11. Discovery disabled or discovered binding forgotten -> external container still running.
12. Due certificate with no project/deployment: stopped backend -> zero new ACME
    orders and retained binding/certificate; start -> immediate renewal on the
    correct server. A valid certificate is reused without an order.
13. Concurrent replicas of the control plane -> one effective reconciliation writer.
14. Existing manual project domain and dashboard HTTPS -> unchanged and healthy.
15. Deleted route file or outdated config -> startup/periodic repair restores it
    from server-domain records without deployment or operator intervention.
16. New certificate attempt while DNS/ACME is invalid -> pending/error with retries;
    existing project ownership checks and cross-server hostname conflicts remain intact.
17. Queued renewal followed by stop, or engine inspection failure -> deferred order;
    successful inventory after start resumes it. Repair while stopped performs no ACME work.
18. Invalid replacement scanned repeatedly -> retained binding and invalid state,
    no stale upstream, no repeated generation bumps or duplicate withdrawal work.
19. Applied -> blocked/suppressed -> removed -> retirement still queued and retried;
    retirement followed by replacement cannot delete a newer valid route.

Required compatibility matrix (record engine/version and actual observations):

| Mode | Connection and topology | Required evidence |
| --- | --- | --- |
| Docker rootful | Local mounted/configured socket and SSH; user-defined bridge | Per-network direct IP and live published-port routes reach Edge |
| Docker rootless | Configured user socket; rootless network namespace | Published-port routing works; direct-IP mode is used only when reachable |
| Podman rootful | Configured compatibility socket, local and SSH | Inventory/inspect/network/events normalize; bridge and published ports work |
| Podman rootless | Correct user's compatibility socket, local and SSH; custom bridge and `pasta`/`slirp4netns` where available | Reachable published endpoint, no assumed host access to private IPs, stop/start TLS and recovery work |

For each supported Compose provider, verify stable labels or document the explicit
service ID fallback. Add sanitized fixture tests for inspection/network/port/event
payloads from both engines. Test two API users/endpoints with similar identities
without mixing inventories. Unit fixtures do not replace the live Podman canary.

Use staging ACME for repeated issuance tests when supported by the existing flow;
make one real production issuance on the final test domain before declaring rollout complete.

### 8. Build, canary, and deploy tonight

- Finish implementation and gates before changing the target instance.
- Use this fork's publication paths: `.github/workflows/fork-images.yml` and
  `scripts/fork/build-images.sh`, documented in `docs/fork-maintenance.md`.
  Do not base the rollout on the upstream `docker-images.yml`/`release.yml` jobs.
- Run the required tests/typechecks/release checks against the exact source being
  built. The fork image workflow's `gate` checks VERSION CHANGES, not test success;
  successful publication alone is not validation evidence.
- For an isolated canary, use the local builder with an explicit unique `--tag`
  and only the changed images (normally api/dashboard). An explicit tag replaces
  its default version/version-SHA/latest tag set. Build from the tested checkout;
  record its commit and any intentionally included local changes. Prefer a clean,
  reviewed commit for the deployment artifact.
- For the normal fork CI path, note that manual dispatch checks out `main` and
  publishes version, version-SHA, AND `latest` tags. A push with unchanged version
  does not publish automatically. Verify the built SHA matches the tested commit;
  use the uniquely tagged local canary path when moving shared tags is undesired.
- Resolve and record registry digests; pin the canary and rollback images by digest
  in the existing instance update/Compose configuration. Avoid a generic
  `openship update` during the canary if it would repin to the CLI's version tag.
- Confirm target architecture. Fork CI currently builds `linux/amd64`; the local
  builder accepts `--platform` when another architecture is required. Preserve
  `OPENSHIP_IMAGE_REGISTRY` and the target's Docker/Podman Compose/provider settings.
- Build queue/runtime is external to the implementation estimate. Use the target's
  established deployment mechanism; inspect the resolved image pins before restart.
- Save database backup and current image digests/configuration; verify restoration
  access. Apply only the additive migrations and release artifacts required.
- Deploy the control-plane changes with discovery disabled. Update dashboard when
  its UI changes require it. Reuse the current Edge image if its API/configuration
  contract remains sufficient; discovery lives in the control plane.
- Confirm control-plane health and existing domain HTTPS first.
- Enable discovery for one server and one test service; observe initial inventory,
  ACME validation, issuance, Edge route application, and HTTPS response without
  creating an Openship project/deployment or requesting a TXT ownership token.
- Recreate that service once and verify automatic upstream replacement.
- On the fork's Podman target, also stop/start it and verify no certificate order
  while stopped, correct certificate reuse/renewal on start, and recovery after
  an event reconnect. Confirm the actual upstream from Edge's namespace.
- Enable the intended opted-in services on that server, verify every endpoint,
  and observe at least two repair sweeps without unintended writes/errors.
- Record deployed commit/digests, migration state, discovered identities/domains,
  test results, and rollback artifacts in the implementation handoff.

Done: target instance runs the release, discovery recovers a replacement container,
HTTPS works, and pre-existing domains still work.

## Rollback

- First disable discovery and withdraw its application routes using the new release.
- If the application cannot run, use the recorded binding inventory and the
  existing Edge management path to withdraw only discovery-owned routes.
- Restore the previous control-plane/dashboard digests using the recorded mechanism.
- Leave additive tables/columns in place; do not run a destructive schema rollback.
- External containers/networks remain untouched. Retain certificate material.
- Verify existing domain routes and dashboard access. Re-enable only after repair.

## Tonight's sequencing and decision points

Work sequentially: server-domain Edge/TLS proof -> parser/inspection -> persistence ->
reconciler/TLS -> watchers -> minimal UI -> integration gates -> canary -> rollout.

Planning allowance: approximately 8–12 hours for this bounded first release if
the shared Edge/TLS paths can be extracted cleanly, plus CI/publication and DNS/ACME delays.
Re-estimate after the Docker/Podman topology proof: the full rootful/rootless
compatibility matrix and any missing socket/upstream plumbing may require more
time than the original Docker-only allowance. Tonight's first rollout should be
the validated Podman canary on the fork's actual target; record other modes as
unverified until their live checks pass rather than claiming broad support early.
This is a working estimate, not a deployment guarantee. A shorter window should
prioritize a single-server canary; do not omit ownership/lifecycle validation to
meet the clock. Broader server rollout can follow the validated canary.

Open operational input: exact deployment instance/server and its normal update
workflow. Implementation preparation and local validation do not depend on that
answer; publishing or rolling out to an unspecified instance does.
