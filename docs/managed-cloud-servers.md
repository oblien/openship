# Managed Cloud servers

A Cloud subscription owns one Oblien server. Projects select that server through
`serverId`, exactly as projects select a connected self-hosted server. The indexed
`project.workspaceId` is derived from the server and identifies its subscription;
provider VM IDs are internal execution bindings, never application container IDs.

## Shared execution

| Responsibility | Connected server | Managed Cloud server |
| --- | --- | --- |
| Docker applications | `DockerRuntime` via socket or SSH | `CloudDockerRuntime`, extending `DockerRuntime`, via an authenticated Oblien bridge |
| Bare applications | `BareRuntime` with host supervision | `BareRuntime` with `CloudProcessSupervisor` |
| Commands, files, builds and terminal | Local/SSH executor | `CloudWorkspaceExecutor` and provider terminal |
| Routes and certificates | Host edge provider | `CloudInfraProvider` and Oblien Pages/routes |
| Host purchase, resize and deletion | Server owner | Subscription operations |

There is no separate native per-project Cloud deployment engine. Bare is a
project runtime choice on the same managed server; Docker sidecars remain Docker
containers. Builds, releases, environments, backups and project cleanup use the
shared engines. Application operations never create, resize or delete a VM.
An unbound Cloud platform can inspect infrastructure but rejects application work
until the server, subscription, namespace and project ownership are resolved.

Self-hosted and desktop installations acquire or link managed servers through
the same server operations. A local encrypted connection pins the Cloud API URL,
user, organization, server and subscription. Runtime credentials are scoped to
that server's namespace; a disconnected or switched account cannot reuse cached
credentials or cached host usage. Project configuration remains local. Cloud
stores the installation's registered project identities to coordinate host
administration without copying projects or introducing another deployment engine.

## Capacity and lifecycle

Checkout provisions the purchased server once. A sole destination is selected
automatically; adding another server starts an independent subscription. Projects
use the host's full available CPU and memory by default (`unlimited`, represented
as zero container limits). Optional project and Compose limits use the same
inheritance and Docker enforcement as connected servers; they never resize the VM.
The destination settings page keeps the server picker above visible settings and
a preview/Continue sidebar. New v8 offers impose no project or service-count limit within the purchased
server; the provider namespace permits one VM. Saved paid contracts keep their
own limits. Disk usage is measured from the filesystem and Docker inventory. Shared
images, caches and system files are reported separately from project data.

Source builds receive only the user's saved CPU and memory caps. Missing or zero
values impose no additional Docker limits, including on managed servers. Catalog
sizing recommendations never become service settings during install or Retry.

Admission reserves a full host dimension for an uncapped build dimension, so an
uncapped build cannot overlap another build on the same server. These reservations
remain independent of the limits sent to Docker. Automatic builds read verified
VM allocation without sampling idle CPU or free RAM; explicitly capped builds
retain live admission checks. Plan concurrency is still a ceiling, not a request
to subdivide a build or provision another VM.
Builds and host changes coordinate through the existing server activity lock.
A resize stores the prior host state and running container/process identities
before asking Oblien to change resources. Recovery continues after a lost response
or cancellation, restores only previously running applications, and verifies the
provider's allocation. A stopped server stays stopped. Disks are never shrunk.

Project deletion removes project-owned runtimes, routes and selected persistent
data. It retains the host, subscription, neighboring projects and retained data
when volume deletion is not requested. Only an empty server whose subscription
has ended can enter host deletion. Financial history remains with the provider.

## Boundaries and recovery

- `serverId`, subscription, namespace and project ownership are checked before
  opening the provider connection. A Cloud request cannot fall through to the
  control plane's local Docker socket or filesystem.
- Provider account and namespace credentials stay server-side. An explicit
  server-admin operation can reveal a workspace-only Runtime API token or a
  short-lived SSH credential. Source uploads must
  belong to the same organization, project and server; a stored local path is not
  authorization to transfer a control-plane directory.
- Host activity uses `cloud:workspace-activity:<subscription>`. Runtime/route
  mutations use `cloud:server:<provider VM>`, and transport setup has its own
  `cloud:docker-bridge:<provider VM>` lock. Do not acquire an outer activity lock
  again from a runtime operation that is already inside it.
- Activity claims survive controller restarts and coordinate independent linked
  installations. Commands and terminals record intent before remote execution;
  cancellation confirms process-group termination. Docker requests record intent
  before opening their bridge tunnel, and the guest journals completion only
  after reading the original daemon response. A lost controller response never
  authorizes blind replay or a timed unlock. A bridge crash with an unfinished
  mutation requires a provider-console server restart and retry of the original
  operation; only a changed host epoch proves old work cannot still run. Completed
  request journals and cancellation tombstones are retained on the server.
- Cancelling an interrupted deployment can recover its worker completion record.
  Recovery first tries the same in-process and Postgres server locks, then confirms
  recorded remote commands have ended. It never takes a live replica's work.
  Retrying a terminal deployment uses the same recovery; a worker still queued
  for the server rechecks cancellation before starting. Cleanup protects live
  releases and volumes and preserves a recorded keep-resources cancellation.
- Oblien ingress and certificates are provider-owned. Route writes validate
  project listeners and replace the complete desired rule table. Operation logs
  and failures remain visible; an HTTP acknowledgement alone is not proof that
  a VM or process completed its state transition.
- Stopped managed hosts are not restarted by monitoring. Docker health and
  usage reuse the shared collectors; reads stay project-scoped and sampling
  budgets remain per physical server. Bare usage follows its process identity.
- Billing cannot produce complete project/service/route counts or build minutes
  when linked installations own some application records. Those counters are
  nullable; purchased capacity, provider charges and measured host usage remain
  authoritative. Do not replace unknown application counters with zero.
- Linked server deletion uses a durable, organization-scoped receipt keyed by the
  original operation. A missing server row alone is not proof of successful
  provider deletion.

Converting customers from the retired Cloud architecture is handled manually,
outside this implementation. No compatibility engine or customer backfill job is included.

## Customer-initiated imports

Cloud exposes the existing project-import wizard with migration-only SSH sources.
They use the normal server table with `purpose: migration_source`, encrypted
credentials and a pinned host key. Public DNS is checked and the dial address
pinned before connecting. These rows cannot be deployment destinations, terminals,
jobs or infrastructure targets; Cloud migration targets must be owned managed servers.

Both endpoints and every affected project are authorized in the active organization.
The shared migration orchestrator uses the existing Docker/SSH/provider adapters,
storage planner and deployment worker. Managed imports scope volumes and bind paths
to the project. Temporary transfer trust, original placement and container state
are checkpointed for rollback and recovery. An active run prevents source removal
and managed-server deletion or resize until its remote work has settled.

The database permits managed-project rebinding only through a transaction tied to
the matching migration and its saved source checkpoint. Retained deployments keep
their original owned server binding when a project moves.

## Verification boundaries

The real API route graph must pass the boot scanner in both Cloud and self-hosted
modes. Runtime verification covers project isolation, environment/data retention,
source ownership, provider failures, resize recovery, routing and disposal.
Disposable local Docker tests exercise the shared engine without using customer
resources. Provider simulation cannot certify the deployed Oblien API; the
staging smoke script requires separate test credentials and explicit execution.

Before release, run `packages/adapters/scripts/verify-cloud-docker.ts` against a
disposable staging namespace. It checks the authenticated Docker bridge, source
builds, routes, retained-image rollback, volumes and server restart. It also
checks the provider's process contract: creation preserves the requested workload
ID; reads return saved command, environment and labels; Start/Stop persist
`enabled`; stopped processes stay stopped
after restarting the server. SDK type checking and simulated responses do not
prove these live provider guarantees.


## Cloud space presentation

Cloud navigation presents managed capacity as **Cloud spaces**. One existing Cloud
workspace remains one independent resource pool, with the same subscription,
allocation, projects, provisioning and execution adapters. Overview shows the
existing usage sample and assigned projects; Activity shows lifecycle progress
and explicit retry. Independent pools are not summed into a fictitious allocation.
Capacity changes use the existing billing review flow.

The managed UI omits host terminals, SSH, networking, Runtime API credentials and
manual process controls, including when opened through Desktop or an old
`/servers/:id` link. Connected self-hosted servers keep their host tools. Project
logs, service consoles, deployments and routing remain available in their project.

This is a presentation change. It does not restrict or remove existing HTTP/SDK
operations, change authorization, migrate projects, revoke credentials or alter
runtime limits. Legacy Desktop execution connections continue to work. Hiding a
control in the UI is not a new security boundary.

## Existing host APIs

The host API and native/HTTP SDK continue to use `ManagedServerResourceSchemas`,
the existing authorization layer, and the same namespace-bound provider connection
as deployments. Their behavior is unchanged by the Cloud spaces UI:

- Settings reports the actual managed image and allocation, and offers bounded
  boot logs. Application image changes stay in project deployment settings;
  replacing the VM image, changing paid resources directly, and destructive TTLs
  are deliberately not controls on an active shared managed server.
- SSH supports enable/disable, one authorized public key, password replacement,
  and temporary connections. Passwords and keys never enter server overview or
  audit payloads. Provider sharing restrictions are honored.
- Runtime API status never enables it. Credential reveal and rotation require
  server-admin authorization and a confirmed request. Rotation compares a hash
  of the current underlying token under the activity lock. A retry after a lost
  success response cannot rotate it again with the old revision. The Runtime API
  is required by Openship; the dashboard does not offer to disable it.
- Native workloads distinguish platform services, project-owned releases and
  manual processes. Only manual processes created by this interface can be
  started, stopped or deleted here. A deterministic ID and request fingerprint
  recover lost create replies without duplicating a process. Creation saves a
  stopped process; starting it is a separate explicit action. Process environment
  and command text are never included in lists or audits.
- Outbound rules use an optimistic revision and a narrow patch. Routes, private
  peers, ingress rules and proxy credentials are never round-tripped by this form.
  Disabling internet clears egress in the provider; re-enabling it explicitly
  sends the displayed destination list. Wildcard ingress is represented as such.

Mutations reauthorize after acquiring managed workspace activity admission, so
linked controllers, deployments and terminals retain their existing coordination.
New execution/access requires authoritative paid entitlement; revocation does not.
Unconfirmed provider results are errors, and unknown process observations are not
reported as stopped. These controls do not promise a distributed SQL/provider
transaction: uncertain replies are recovered by reading state and retaining the
original identity or revision.

Secret responses carry `Cache-Control: private, no-store`. The dashboard holds
credentials in component memory for at most one minute, clears them when hidden,
and ignores responses from a previous account/server/tab. Gateway tokens grant
root-equivalent access to this server, not project-scoped access. Direct SSH/SDK
clients run outside Openship's deployment queue; administrators must coordinate
their own commands with application work.

The provider Runtime endpoint defaults to `https://workspace.oblien.com` and can
be overridden with `OBLIEN_RUNTIME_URL`. All provider methods used here are in
Oblien SDK 2.10.0; no new provider SDK release is required. Deploy the Openship API
and dashboard from the same release to use the new controls. Existing server
response shapes are unchanged. Detailed network reads opt in with
`getNetworkSettings(id, { details: true })` / `?details=true`; writes return
diagnostics only when the caller supplies `expectedRevision`, preserving the
original internet-only contract for older clients.

## Live resource usage

The Cloud spaces page calls each independently purchased allocation a **Cloud space**.
A compact picker in the right column shows the plan, project count and state. Usage and plan capacity stay
scoped to the selected space; projects cannot combine several allocations.

`GET /api/system/monitor/stream?serverId=…&format=usage` and
`ship.servers.monitor(id, { format: "usage", signal })` opt into `usage` events.
The default host `stats` events and existing host operations remain unchanged.
Each event contains `ResourceUsageSample`: a measurement timestamp, quota-relative
CPU percentage, memory used/available in MB and disk used/available/total in MB.
Unknown fields stay null. Actual guest bytes are converted to MB; allocation,
credits, CPU time and memory reservation are not treated as live consumption.
See the [provider metrics contract](https://oblien.com/docs/api/metrics).

Guest byte counters and guest KiB counters are accepted. Zero-total placeholders
are unavailable measurements. Hypervisor process memory includes VM overhead and
is never substituted for guest RAM. When a guest does not publish memory metrics,
the stream uses the existing read-only guest sampler, at most once per ten seconds
per subscription; it closes that connection on cancellation or failure.

Openship verifies server-read access and the existing organization/workspace binding,
then opens the stream with that workspace's namespace credentials. It never exposes
provider credentials to the browser or provisions/resumes a machine to observe usage.
The operation rechecks authorization before each delivered event. Provider streams
reject credential redirects, bound idle reads/incomplete frames and close on abort.
Desktop's saved managed links use the same verified Cloud connection as existing reads.

The dashboard subscribes only while the selected usage view is visible, cancels on
space/account changes and keeps up to 60 recent samples. Failed or stalled reads show
Retry and a last-reading label. Project membership and disk breakdown keep their existing
permission-filtered snapshot request; the live stream does not repeat Docker storage scans.
Deploy the API and dashboard together for live usage; older APIs retain snapshot usage
with an explicit unavailable-live-updates notice.

On `fuse-overlayfs`, the snapshot request skips Docker's full disk-usage inventory.
Its writable-layer sizing walks directory trees in daemon memory, and a caller
timeout does not reliably stop that scan. Host CPU, memory, total disk usage and
project membership remain available; detailed project/shared disk attribution is
null rather than zero on these hosts. Other storage drivers keep their existing
disk breakdown. This read never prunes caches or changes application resources.

Cloud spaces owns instant resource readings and project storage; Billing shows the
subscription, payments, usage over the billing period and entitlement counters.
Both reuse the shared destination picker, catalog names and existing billing scope.
Billing does not fetch a second host snapshot. View links carry the selected execution
identity; Manage plan links carry its subscription identity. Setup links retain Activity.
The existing `/resources` URLs and saved `/servers/:id` links remain compatible.
