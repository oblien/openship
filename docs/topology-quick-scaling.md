# Topology scaling delivery

The topology is a frontend for the existing deployment, native database, and
infrastructure operations. It is not a second scheduler or source of workload
state. Database replicas and migration clones remain different actions.

## Delivered in this change

- One Scale tab in the workload inspector and explicit application instance review.
- Existing compute-cluster runtime setup embedded without leaving the draft.
- Actual versus requested instance counts, timestamps and durable progress.
- PostgreSQL standalone-to-replicated scaling within the same operator resource,
  with separate encrypted writer and reader bindings.
- Redis replication and Sentinel, separate from the existing sharded mode.
  Adding replicas is supported; replica removal stays blocked until a fenced
  primary handoff can be proven.
- Shared admission reasons for unsupported application workloads.
- Revision/sequence guards, organization isolation and reader-consumer protection
  during downscale. Existing operations own retry, cancellation and recovery.

## Runtime support

Application scaling reuses the existing Kubernetes and connected Swarm runtimes.
Swarm Compose workloads keep their existing stateless-service scaling and
manager-pinned, single-instance placement for named-volume services. The active
project replica setting, not the sum of all service tasks, is the review baseline.

Managed PostgreSQL and Redis replication require Kubernetes operators. Swarm
targets are rejected before saving or scheduling database creation; the topology
does not offer them as database destinations. Replicating a container never
substitutes for database replication or failover coordination. Existing Docker
and bare databases require the explicit migration described below.

## Subsequent delivery

These are backend features, not switches to reveal in the current UI:

1. **Standalone Docker/bare database conversion:** plan an engine-specific backup
   and data transfer, final catch-up and write fencing, verify the destination,
   then switch consumers explicitly. Track the writer generation so recovery
   never reactivates a stale primary. Keep source data until verified cleanup.
2. **Independent per-service Compose settings:** extend the existing Swarm release
   flow with a persistent per-service scaling
   target and immutable artifact delivery, preserve service/environment secrets,
   storage and private links, and use the current release/cutover pipeline. Do not
   apply application copies to database services. The existing Swarm flow keeps
   named-volume services at one instance.
3. **Cloud cluster execution:** implement private control-plane transport and
   verified machine identity for provider-managed execution endpoints. Reuse the
   same operation contracts and capability checks. Resource placement uses an
   explicitly selected customer pool. Provisioning/billing for extra servers
   requires a reviewed purchase; this change makes no provider purchases.
4. **First-use infrastructure setup:** embed existing network preparation/review
   and cluster creation in the workload flow, without silently accepting provider
   firewall rules or creating a parallel network wizard.
5. **Policy-driven autoscaling:** an independent later controller, with explicit
   minimum/maximum instances, budgets, cooldowns and placement rules.

## Acceptance

Focused tests must cover review/cancel, scope switches, stale settings, failed
permission reads, environment ownership and encrypted writer/reader transactions.
The real Linux scaling journey must prove PostgreSQL 1→3→1 preserves committed
data and reader behavior, and Redis replication preserves data and recovers after
primary host loss. A new desired configuration or accepted HTTP response is not
proof of runtime readiness. The PR records which acceptance checks actually ran.

## Demo: choose the outcome first

| User outcome | Control | What it actually does |
| --- | --- | --- |
| Serve more traffic with the same app | Scale → Instances | Maintains a fixed count on a supported Swarm/Kubernetes runtime. Healthy instances receive traffic; failed instances are replaced. |
| Give a service more CPU or memory | Scale → Advanced | Changes resource limits through the existing reviewed deployment flow. |
| Create a test environment or independent snapshot | Scale → Duplicate | Creates a new project containing the selected services, independent storage and settings. It has no domains until configured. |
| Keep a database available after failure | Managed database → Scale | Uses the PostgreSQL/Redis operator and its replication/failover rules. It is not a container-copy operation. |
| Relocate an environment | Scale → Advanced → Move | Transfers the environment to another server, verifies it, then waits for cutover confirmation. |

### Application instances

1. Use a disposable stateless application on a prepared runtime. Open its Scale tab.
2. Show the **observed** ready count before entering a new count; save/review is not proof of readiness.
3. Review 1 → 3, deploy, wait for three healthy instances, and send requests that report instance identity.
4. Remove one test instance and demonstrate replacement without a new release.
5. Review 3 → 1, then demonstrate a failed release leaving the active release available.

The count stays fixed until the operator changes it: this is not traffic-based autoscaling.
Multiple instances on one server do not survive loss of that server. Swarm's current
count applies to each stateless service in the environment; local-volume services
stay at one instance. Independent per-service counts, arbitrary Docker conversion,
and Kubernetes Compose replication are not complete flows. Show the capability
reason instead of promising these paths. Do not present cloning as a workaround.

### Duplicate on the same server

1. Open a service's Scale tab → Duplicate service. The chosen service is selected;
   add its dependencies if the form asks for them. Empty selections stay empty.
2. Select the current server, name the copy, and review the data pause and domain behavior.
3. For named-volume data, the selected source group pauses for the snapshot and
   restarts before target deployment. Stateless copies leave the source running.
4. Follow progress in the normal migration session. Check the new project has its
   own identity, new port bindings and separately scoped volumes, and no domains.
5. Change data in the copy and verify the original did not change. Check the
   original's public route still serves its existing release.
6. Demonstrate a rejected empty selection, missing dependency, and retryable failure.

Same-server copies currently refuse host bind mounts before stopping anything;
choose a different server or migrate the data into a named volume first. A partial
copy must include other running services writing to the same storage. Worker-role
workloads and single applications with mounted data remain refused. Database copies
are snapshots, not synchronized replicas. External connection strings and copied
secrets must be reviewed before using a copy with production dependencies.
Writers outside the project must be stopped separately; the copy refuses to pause
unrelated containers. In-place imports use the validated active deployment's exact
container identities, so renamed services can be duplicated without a redeploy.

### Checks for this flow

- `project-migration-flow.test.tsx`: selection/load/retry, dependency admission,
  review/cancel, same-server copy vs move, double-submit and project switches.
- `TopologyInspector.test.tsx`: one Scale entry, one status, actions before details,
  operation locks, and inspection-only pods.
- `project-move.test.ts`, `project-clone.test.ts`, `migration-data.test.ts`,
  `rollback-target-volumes.test.ts`: ownership, explicit empty scopes, shared writers,
  dependency/namespace checks, port isolation, single-app copies, named/anonymous
  volumes, original running states, cancellation and exact cleanup ownership.
- `project-move-role-work.test.ts`: active imported container identities, renamed
  services, stale/foreign deployment references and external storage writers.
- `migration-takeover.e2e.test.ts`: real SSH/Docker/edge lifecycle, same-server
  independent data, original domains preserved, and stateless source uptime.
- `scaling-full-cycle.e2e.test.ts`: real HTTP/SDK/MCP, registry, deployment and edge
  traffic, updates/rollback, failed/cancelled release recovery and node/instance loss.
- `scaling-databases.e2e.test.ts`: actual PostgreSQL/Redis data, operators, replica
  changes, failover and recovery. This suite requires its declared S3 test dependency.

Run daemon tests with `RUN_DOCKER_E2E=1` and an isolated `DOCKER_HOST`, through
`apps/api/vitest.e2e.config.ts`. Missing infrastructure is a failure, not a skipped
pass. The application journey uses `E2E_SCOPE=scaling-application`, database journey
`E2E_SCOPE=scaling-databases`; the migration file can use `E2E_SCOPE=fast` plus its
file path. UI fixtures must remain local; do not ship preview routes or run these
mutations against registered customer hosts.

### Local verification — 2026-11-15

- Application scaling: all five real Docker/Kubernetes/edge cases passed.
- SSH migration and same-server copies: all six real cases passed, including
  refusal of an external storage writer before pausing the original, independent
  volume contents, unchanged domains, and an uninterrupted stateless source.
- Focused migration, ownership, recovery and inspector tests passed. Browser
  checks passed in light, dim and dark, including the real server picker,
  confirmation cancellation, keyboard focus and the mobile layout.
- Database replication/failover is **not verified by this run**. The nine-node
  local test cluster lost its control plane during startup; the operator journey
  still needs to finish on a suitable isolated runner before a verified demo.
- Full type checks remain blocked by existing auth dependency/type errors in the
  API and two `Promise.withResolvers` library errors in dashboard tests. No type
  errors were reported in the changed scaling/copy flow.
