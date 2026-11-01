# Cloud build ownership and recovery

Cloud-local builds use durable per-deployment activities. Linked installations and
self-hosted execution retain exclusive workspace admission. Queue policy selects
capacity; activity ownership protects commands and server lifecycle independently.

## Reservation and execution

The queue reads capacity under `cloud:build-admission:<workspaceId>` and reserves
resources in the same database transaction as the deployment execution claim.
`reserveCloudBuildActivity(tx, identity, resources, buildSessionId,
exclusivePreparation)` is the composition helper. The last argument defaults to
`false`; its persisted value must match on an idempotent retry.

| State                         | Capacity                          | Lifecycle protection                                    |
| ----------------------------- | --------------------------------- | ------------------------------------------------------- |
| Reserved, `ownerToken = null` | Resources remain reserved         | No host admission; lifecycle work can still start       |
| Activated, slot retained      | Resources remain reserved         | Per-execution activity plus legacy singleton barrier    |
| Activated, slot released      | Build capacity is available again | Activity and singleton still protect deployment/cleanup |
| Finished                      | No reservation                    | Last active execution clears the singleton barrier      |

`listReservations` returns outstanding capacity reservations. `listActive` returns
all unfinished rows for the workspace/organization, including unactivated rows and
activities after slot release. Backup coordination uses the latter and the frozen
`exclusivePreparation` flag; it must not infer backup requirements from mutable
policy after admission.

Activation requires a ready provider binding. Under the workspace row lock, it
checks current CPU/memory capacity, memory headroom, and active sibling build
allocations. This closes the downsize-between-reservation-and-activation case.
The bound provider identity is then persisted on the activity.

Unset CPU and memory caps stay zero in the admission ledger and in Docker: those
dimensions share the host rather than reserving all of it. Each source build still
owns a distinct row and consumes a plan concurrency slot. Explicit dimensions keep
their existing capacity and usage checks. Image-only deployment phases retain
lifecycle protection without consuming a source-build slot.

Creating the queued deployment is DB-only work under `withProjectStateLock`, which
shares the project advisory lock with runtime mutations and deletion. It never
claims exclusive workspace admission. That state-only scope cannot upgrade to
runtime privileges; actual workers acquire the existing shared build activity.

## Ownership boundaries

Wrap the entire detached worker in
`withCloudBuildExecutionOwnership(deploymentId, work)`, including pre-deploy
backups, final acknowledgement, and cleanup. Re-read durable deployment state
immediately after acquiring ownership, before backups. A recovery worker may have
cancelled an unactivated reservation before a delayed worker reached this point.

`withCloudBuildActivity(identity, work, signal?)` reuses same-execution ownership
and holds the separate `cloud:build-project:<projectId>` mutex through its callback.
This permits nested project-runtime locking without reacquiring the build mutex.
Nested workspace admission is permitted only for the exact `project:<projectId>`
scope. Lifecycle, unscoped, and different-project admission cannot inherit it.

Detached workers must clear inherited advisory, project-runtime, workspace-activity,
and build-activity contexts. `runOutsideCloudBuildActivity` clears both shared
activity and execution-ownership contexts. Clearing context does not release the
parent's locks. Do not wait for a detached worker's lock while still holding queue
admission: a small PostgreSQL lock-permit pool can deadlock that handoff.

Repository activation and completion take the workspace row lock before activity
row locks. The first activation writes a stable singleton activity with scope
`cloud-builds`, controller `saas`, and ID `cloud-builds:<workspaceId>`. Older
controllers see that singleton and reject exclusive work even though they do not
know about the shared table. Only the last successful completion clears it.
Already-active rows created before this compatibility barrier require draining or
backfilling before a mixed-version rollout.

## Command and BuildKit quiescence

Command intent belongs to the exact deployment activity and provider binding.
Owner tokens fence late command callbacks after recovery takes ownership.
Unconfirmed commands prevent activity completion.

Stopping a tracked exec process group does **not** prove that a Docker-owned
BuildKit container stopped. The project builder identity is centralized in
`projectBuildKitWorker`; creation uses an explicit node name compatible with the
original single-node naming scheme.

By default, `releaseCloudBuildSlot`, activity completion, and active recovery call
`verifyCloudBuildWorkerStopped` under execution/project ownership and managed
command tracking. The helper first requires issuing commands to be settled, then
removes the exact project builder and verifies container absence through Docker.
Missing buildx metadata or a failed daemon query is not evidence of worker exit.
Only confirmed daemon absence permits release. A failed verification leaves the
activity open even when its recorded command list is empty.

## Recovery

`recoverCloudBuildActivity(identity, cleanup)` tries both execution and project
locks without waiting behind a live owner. It never recovers sibling commands.
For an activated row it recovers recorded commands, verifies the BuildKit worker,
runs cleanup, and finishes the activity. Cleanup must re-read destination and
deployment state and protect retained/live releases.

For an unactivated reservation, cleanup receives `{ activated: false }` and must
perform DB-only work. Recovery cancels the reservation after successful cleanup;
the callback may also cancel it atomically with its state changes. Failed cleanup
leaves the row retryable. Separate backup/provisioning operations retain their own
fences.

The recovery sweep must cover open activities after session acknowledgement and
finished activities with unfinished execution leases. A short grace for fresh
unactivated reservations is only a scheduling delay; exact lock acquisition is
still required. Snapshot offset pages before mutating their rows.
When an activity already finished, recheck and settle its interrupted deployment
under the execution/project locks before acknowledging the build session. A failed
state write remains retryable. This receipt does not reopen host work or delete a
successfully recorded release.

## Activation contention

Manual backup or maintenance can acquire exclusive admission after queue sampling
or reservation and before shared activation. A foreign singleton rejects the
reservation transaction, leaving the build queued. A later activation refusal
uses a distinct error that cannot be confused with failure inside build work.
After releasing the project mutex, the pipeline atomically resets only an
untouched reservation and its execution lease to queued, preserving submission
order. Cancellation and activated work cannot be reset by this transition.

The old worker retains execution ownership until its local cancellation registry
is released. A new worker registers only after acquiring that ownership. The
periodic sweep retries admission; no immediate retry loop holds the project mutex
or prevents recovery from using it. Work that has already started is never replayed.

## Migrations and verification

`0182_cloud_build_activity` creates the original activity table.
`0183_cloud_build_exclusive_preparation` adds the default-false preparation flag.
Do not fold the latter into an already-applied `0182`.

Focused tests cover reservation transactions, capacity revalidation, the old
singleton-only protocol, exact-execution recovery, default worker verification,
and upgrading existing `0182` rows without losing pending commands. The optional
PostgreSQL integration suite uses independent database clients to exercise
admission races, lock ordering, and both execution-owned activation/deferral
orderings on an ephemeral database. Docker daemon behavior is mocked; a deployed
Docker crash-recovery check remains separate from these automated tests.
