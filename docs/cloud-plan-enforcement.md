# Cloud plan enforcement

These limits apply to new Cloud offers (offer version 13). Existing purchased
offers retain their saved limits. Self-hosted installations do not use these
Cloud quota gates.

| Plan    | Monthly price | CPU    | RAM   | Disk   | Projects/apps | Running services | Build admission ceiling |
| ------- | ------------- | ------ | ----- | ------ | ------------- | ---------------- | ----------------------- |
| Hobby   | $12           | 1 vCPU | 4 GB  | 50 GB  | 3             | 4                | 1                       |
| Starter | $24           | 2 vCPU | 8 GB  | 128 GB | 10            | 15               | 4                       |
| Pro     | $47           | 4 vCPU | 16 GB | 250 GB | 25            | 40               | 8                       |
| Scale   | $119          | 8 vCPU | 32 GB | 600 GB | 50            | 100              | 20                      |

Annual charges are $120, $240, $468 and $1,188 respectively, paid upfront.
Their displayed monthly equivalents are $10, $20, $39 and $99. Both intervals
use the same capacity and application limits. Catalog changes do not rewrite
existing paid subscription terms or their renewal prices.

Hobby includes email support. Starter is the featured plan. Projects/apps share one project allowance; services
share the subscribed server's capacity. Container resource ceilings do not
reserve that amount of memory for every service.

## Traffic

Egress is excluded from plan limitations. This change introduces no bandwidth
allowances, traffic caps, egress enforcement, or overage charges. Traffic
analytics are independent of plan enforcement.

## Deployment and upgrade behavior

Project creation and service admission enforce the saved offer on the selected
managed server. Queued deployment service reservations count toward the service
allowance; drafts do not. Confirmed stopped services release their running slot.
Starting a stopped service reserves its slot before the runtime call.

Explicit build resources are validated rather than silently reduced. Capacity
refusals allow customers to review the server or upgrade. Plan refusals identify
the relevant server and allowance. A successful billing refresh enables retry;
the deployment API still validates the request. Failed retries retain the modal
and configured project.

## Queue and execution ownership

Only explicitly submitted jobs enter the durable queue. Workspace admission is
serialized across replicas. FIFO uses first submission time, not draft creation
time. Global sweeps interleave workspaces and collect pages before dispatching.
Permanent configuration errors terminalize only unclaimed jobs; temporary server
errors, rate limits and resource pressure keep jobs queued. The UI shows queue
position, the waiting reason, and an optional upgrade action.
Maintenance that wins the race between reservation and activation returns only
untouched work to the queue atomically; its submission order is preserved.

Migration `0182_cloud_build_activity.sql` adds durable execution ownership and
resource reservations; `0183_cloud_build_exclusive_preparation.sql` adds the
captured preparation requirement without rewriting an already-applied migration.
Different projects may build concurrently on a Cloud
server. Same-project builders remain serialized. Existing provisioning and
project mutation locks remain in place, and live or unresolved shared activities
exclude server lifecycle operations. Pre-deploy backups retain exclusive
preparation; jobs involving them wait for other activities to settle. The required
backup-policy set is captured at admission, including an explicitly empty set;
subsequent policy edits cannot change the preparation lock requirement mid-flight.

The plan values are ceilings. The scheduler also checks CPU reservations, measured
free memory, and host headroom. Unknown measurements wait; explicit requests that
cannot fit the purchased server fail with an actionable resource message.
Reservations conservatively subtract outstanding memory even when current usage
already includes part of a build. Available capacity can therefore permit fewer
parallel builds than the plan ceiling. No scheduler can infer arbitrary source
code's peak memory usage from its repository alone.

Automatic builds use the server's measured available capacity rather than a
fixed 1-vCPU / 4-GB worker. Memory leaves 5% operating-system headroom (128–512 MB)
and subtracts outstanding build reservations. Automatic CPU subtracts outstanding
reservations from sampled idle capacity, bounded by unreserved server CPU. Running
builders may be conservatively counted twice, as with memory. An explicit
dimension is preserved; only missing
or zero dimensions are automatic. Unknown samples or extreme CPU pressure wait
instead of launching a worker. The plan concurrency allowance is a ceiling;
automatic builds can consume the available budget and queue subsequent builds.
Smaller explicit build limits permit concurrent builds when they fit. The minimum
is 0.25 vCPU and 128 MB RAM. Automatic allocation is selected at admission and
stays fixed for that worker; it is not resized during a build. An explicit request
waits for its chosen resources rather than being silently reduced. Allocated
resources are printed in the build log. Available capacity is not a guarantee
that every application's compiler fits.

Single-app builds release their slot after source building and before deployment.
Compose releases after its image-build batch. Image-only deployments do not
reserve a build slot; retained-artifact operations reserve for a possible source
fallback and release once reuse is confirmed. Slot release does not release host
command ownership. Unconfirmed commands retain their reservation for recovery.
Docker-owned BuildKit workers must also be confirmed absent before capacity is
released; stopping an exec process alone does not prove its worker stopped.

Execution locks cover backups, build, deployment and acknowledgement. Detached
workers cannot inherit the submitting request's lock ownership. Recovery must
try-acquire that exact execution lock and cannot stop a live sibling's commands.
An interrupted execution is marked failed only after ownership is obtained; its
commands and owned artifacts are recovered before capacity is released. Jobs
that were still waiting remain queued and resume automatically. Builds already
interrupted during execution require redeployment rather than silently replaying
release commands or migrations.

Queue dispatch and command recovery have separate periodic jobs so slow recovery
does not prevent ordinary dispatch. No timeout is treated as proof that a remote
command stopped. Linked installations retain their existing exclusive protocol;
the shared activity protocol is restricted to Cloud-local managed servers.
