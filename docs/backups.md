# Backups and restore

Backup policies define the source, destination, capture method, triggers and retention.
The dashboard, HTTP API and SDK use the same engine operations and worker lifecycle.

## Start a backup

Choose **Back up now** in a project's Backups tab, a service's Backup tab, or the
service's Volumes panel. The first run asks for a destination and policy; **Save and
back up** saves that policy and starts capture. Later runs use the saved settings.

A service can use a project policy without creating a duplicate policy. The service
shortcut runs that policy for the selected service only. Editing the inherited
settings creates a service policy. Running the project policy from the project page
backs up its eligible enabled services, with a separate run and progress stream for
each. All child rows are admitted in one database transaction before workers start.

The API and SDK return `runId` for compatibility and `runIds` for the complete batch.
An optional `serviceId` selects one service within a project policy; services outside
the policy's project are rejected. Reconnecting a progress stream never starts a
second backup.

Recent backups and destinations appear above policies. History loads ten runs at a
time, with **Load older backups** to continue. The API and SDK preserve their array
response: pass `before: lastRun.id` and `limit` to request the next page. Ordering uses
the saved start time and run ID, so services admitted together do not disappear at a
page boundary. Retention can prune the cursor's backup without breaking pagination.
An `active: true` query finds in-progress runs independently of the history page.
The dashboard keeps tracking those runs when their details are dismissed, so hiding
progress cannot leave policy controls or the recent results stuck in an old state.

Progress uses one read-only stream. The engine reads the saved state every five
seconds while that stream is open, and coalesces local worker notifications into
earlier reads. This also works when the worker runs in a different process. Terminal
snapshots include the saved finish time and byte count. Reads do not overlap, and
completion or disconnect removes the subscription and timer. The dashboard ticks
elapsed time independently, updates history in place, and shows the current phase
and transferred bytes without inventing a percentage for an unknown capture size.

## Global backup pages

`/backups` shows recent runs across destinations, with service/project names,
captured database or volume contents, results and sizes. A destination's detail page
shows its own history and the policies currently using it. History remains visible
when a policy is deleted or moved. Service restores and run details use the same
wizard and progress component as the project page; mail backups link to their mail
server's backup view.

Both histories use ten-row cursor pages. `backupDestinations.history()` and
`backupDestinations.runs(id)` expose the same engine queries to the HTTP and native
SDKs, with `limit` and `before` options and `{ runs, nextCursor }` results. Their HTTP
paths are `/api/backup-destinations/history` and `/api/backup-destinations/:id/runs`.
The overview response projects display metadata only, never artifact commands or
credentials. Queries and cursors are scoped to the authorized organization and,
where requested, destination.

**Saved backups** counts retained successful runs; active, failed and cancelled
attempts are separate. **Total stored** counts referenced physical objects once,
including shared incremental blocks, so it need not equal recent transfer totals.
**Last run** uses the same UTC timestamp decoding as the individual history rows.
A failed destination probe takes precedence over an older successful verification.

The pages refresh on demand and on returning to the browser tab. While runs are
active, a visible page refreshes every 15 seconds without overlapping reads. It
refreshes the selected history page in place. Loading failures offer Retry and
preserve already loaded data; an unavailable API does not become an empty destination
list or a false not-found page.

## Rules and retention

- New policies are enabled, manual and full by default. A schedule, pre-deploy trigger
  or webhook must be chosen explicitly. Cron schedules use the server's time zone.
- The default retention is **7 successful backups per service per policy**. Count and
  age limits can be combined. Explicitly clearing both means unlimited retention.
- Pausing a policy disables new runs and its scheduled retention. Deleting a policy
  does not silently delete its existing backups.
- Protected backups and sources of active or prepared restores are excluded from
  automatic deletion. They can exceed the normal retention count. Protection applies
  to the selected saved backup; it does not capture the service's current data.
- Pruning runs after a successful capture and through the recurring retention sweep.
  It waits for the capture worker to finish recording the backup. Failed object
  deletion is retained for a later cleanup attempt.
- Each queued run retains its original destination. Changing a policy's destination
  affects later runs; older backups still restore and expire at their original store.
  A referenced destination cannot be deleted or pointed at another store. Renaming it
  and rotating its credentials remain available.

Prefer a separate server or object store for production. A local destination shares
the control plane's disk failure risk and requires the existing local-storage opt-in.

## Capture methods

Automatic detection selects the database producer where supported, otherwise the
volume producer. Explicit policies can select volumes, files and folders, or a custom
capture/restore command. Named volumes and bind mounts are supported; tmpfs is not
persistent storage. Missing or ambiguous selected mounts fail capture, and repeated
mounts of the same physical volume produce one artifact.

The default is application data, not a separate copy of the Git repository or image.
A selected volume can still contain application files; its contents are not filtered
based on whether they also exist in Git.

### Transfer location

Capture commands run at the source, but the backup payload currently streams through
the Openship backup worker to the destination. The worker also computes checksums and
handles incremental blocks. This is **not direct source-to-destination transfer** and
requires the worker and its network connections to remain available until completion.
Closing a progress view only disconnects that read-only view; it does not cancel a
backup. SFTP destinations may be a separate server, but that alone does not remove the
worker from the data path.

Volume capture is crash-consistent by default. Docker's optional **Quiesce** freezes
the service while its volumes are copied, then resumes it even if capture or upload
fails. This prevents concurrent writes but does not flush application buffers. Prefer
a logical database dump for a live database. Bare hosts and native Cloud workspaces
reject quiescing because they cannot provide that guarantee.

Capture commands must exit successfully. A successful compressor cannot hide a failed
dump or tar command. Empty captures, incomplete uploads and mismatched checksums fail
the run. Post-hooks run once after capture, including its failure path. Failed uploads
close their source streams and release their helpers and connections.

### Incremental storage

Enable **Incremental backups** under the policy's Advanced settings, or set
`payloadConfig.incremental: true`. Full backups remain the default and existing full
artifacts remain readable.

Incremental capture splits the producer stream into 8 MiB blocks and gzip-compresses
each block independently. Filesystem producers supply an uncompressed tar stream.
Unchanged blocks from the preceding successful backup of the same source, policy and
destination are reused after reading and verifying their stored bytes. Missing or
corrupt old blocks are uploaded again under the new run's keys.

Each snapshot records its complete ordered block list, reconstructed size and digest.
Restoring a snapshot does not replay a chain of changes. Retention removes old indexes
and only blocks no remaining snapshot references; storage accounting counts shared
physical objects once. Keep the `.chunks.json` indexes, referenced blocks and manifest
together when managing storage outside Openship.

This implementation scans the entire source on every run. Reuse saves new uploads and
retained storage, but verifying reused blocks reads them back, so it does not promise
lower total network traffic. Changes that shift tar offsets or alter compressed dump
output may reduce reuse. Snapshots support up to 131,072 blocks and a 32 MiB index.
Incremental storage adds no application-level encryption at rest; configure encryption
on the destination if required.

## Restore behavior

Every successful backup is a saved data restore point, including incremental backups.
Restoring one does not automatically capture the current data first. To preserve the
current version, run **Backup now** and wait for success before restoring an older
version; protect that new backup if it must outlive the policy's retention window.
The restore wizard's **Protect** option protects the selected saved backup from
retention. It does not create a new backup.

Restore has a preparation phase and a separate confirmed apply phase. Preparation
checks the target, artifact metadata and available data; checksum verification is on
by default. An operator who disables verification in the policy accepts weaker
preparation checks. The apply stream still verifies the bytes it reads.

Volume restores stop the writer and replace the volume contents. Files-and-folders
restores merge by default, unless the policy explicitly requests clearing a safe
target directory. Logical database restores execute through the running database.
Runtime access and stop failures abort before the restore can replace data.

Only one restore can apply to a project or mail server at a time. Project services
share this restriction because they may share volumes. Mail migrations reserve the
destination server. A conflicting apply returns an actionable conflict and leaves
the second restore prepared for retry after the active restore finishes. Requesting
cancellation does not release the target before its writer acknowledges the stop.

Cancellation is a request, and its actual outcome is shown in the progress view.
Filesystem and nontransactional database writes can leave partial data if they fail
or are cancelled. Openship records that outcome and does not automatically restart a
service on a partially restored volume. A PostgreSQL restore uses a transaction, so a
failed single-artifact restore can leave that database unchanged. A multi-artifact
restore is not one transaction across every target.

SSH streams restore input directly when supported. Transports without streaming stdin
stage the artifact in private local and remote temporary directories, verify the
staged length and clean up after success or failure. These transports need temporary
disk space for the artifact. A disconnected host can defer remote cleanup until its
operation settles or require operator cleanup of the reported staging failure.

Modern Cloud Docker services use the same Docker backup executor as self-hosted
Docker. Legacy native Cloud command/file restores use the workspace command transport
and the SDK's tar.gz upload format. Legacy **offline volume restore is refused during
preparation**: stopping that workspace also stops the filesystem API required for
restore. Use a files-and-folders policy for an online restore, or move the service to
the Docker runtime for offline volume restores. Native Cloud transport tests use a
local simulated gateway; they do not certify a live Cloud account's infrastructure.

## Release verification

The existing reusable `release-gate.yml` runs the unit/integration tests and the Docker
E2E matrix before release publishing. Backup E2Es are in its `fast` scope. Setting
`RUN_DOCKER_E2E=1` makes an unavailable daemon a failure rather than a skipped test.

Run the complete backup E2E group against an isolated Docker daemon:

```sh
RUN_DOCKER_E2E=1 OPENSHIP_JOB_RUNNER=in-process \
  bun --no-env-file run --cwd apps/api test:e2e \
  backup-volume-roundtrip backup-db-roundtrip backup-payload-matrix backup-lifecycle
```

The four files cover 27 cases: real Docker volumes and bind mounts, exact wipe/restore,
PostgreSQL restore and rollback on failure, custom commands, folder merge/replacement,
codec handling, quiescing, missing sources, and the public API/SDK backup lifecycle.
The lifecycle fixture uses a separate OpenSSH/SFTP container and storage volume. It
tests incremental reuse and exact restore after pruning the parent, protection,
corruption refusal, destination changes, scheduled runs and pause, upload failure,
helper cleanup, duplicate worker delivery, retention races and project batches. A
paused storage server holds an apply open while a second public apply request is
rejected; both backups then restore their exact data in turn.
The lifecycle stream test deliberately drops worker bus notifications while real
Docker capture and SFTP storage continue. Through the public HTTP/SDK streams it
waits for saved backup completion, prepares and applies a restore, and verifies both
the final restore state and the restored file. The same suite checks cursor pagination
through the public SDK, including project batches.
Fixtures own and remove their containers, volumes, images and temporary storage.

Additional tests cover metadata bounds, storage accounting, database admission races,
SSH cancellation after stdin EOF, the actual Cloud SDK upload contract against a
simulated gateway, policy editing, one-click service backup, restore confirmation,
inline errors and progress reconnection. The Docker E2E group uses the in-process
worker; it does not exercise a separate production Redis/BullMQ deployment or a live
S3 provider.

### Initial audit validation — 2026-09-25

| Suite | Passing cases |
| --- | ---: |
| Docker volume, PostgreSQL and payload E2Es | 17 |
| API/SDK → Docker → separate SFTP lifecycle E2Es | 9 |
| API backup/restore tests | 337 |
| Adapter and command transport tests | 274 |
| Database backup repositories | 46 |
| Shared backup catalog/storage | 78 |
| Worker lifecycle | 6 |
| Dashboard policy, shortcut, restore and progress tests | 94 |

All 26 Docker E2E cases passed together in the final complete-group run. The SFTP
fixture selects a free host port using the shared port helper. No failed assertions
were skipped or relaxed.

Dashboard, contracts, SDK and database typechecks passed. The broader API/adapters
typechecks still report four pre-existing Cloud SDK signature errors in
`packages/adapters/src/runtime/cloud.ts` (lines 2531, 2591, 2649 and 2663 at audit time).
There are no additional type errors from this backup change, but the full release
gate cannot be considered green until that SDK mismatch is resolved.

### Progress and history follow-up — 2026-09-25

The reported PostgreSQL and Redis captures had succeeded in storage while their live
cards remained in preparation. This follow-up fixes durable progress reconciliation,
the elapsed clock, stale snapshot precedence, dismissed-run tracking, and paginated
history. It also places recent backups beside destinations, above policies.

Validation during this follow-up:

| Suite | Passing cases |
| --- | ---: |
| Full Docker/SFTP HTTP/SDK lifecycle | 10 |
| Shared run streams and worker lifecycle | 20 |
| API backup/restore module | 273 |
| Database backup repositories, including history and active-run queries | 51 |
| Dashboard backup flows, streams, schedules and locale parity | 91 |
| Native SDK backup and destination integration | 2 |

After adding active-run queries, the two affected Docker lifecycle cases were rerun
successfully, including cursor pagination through the SDK. The native SDK cases
rebuilt and exercised the Node worker with those same query options. Database tests
cover simultaneous start times, timestamp precision, retention of a cursor row,
tenant isolation, and a cursor that finishes between active-history requests.
Dashboard tests cover missed state refreshes, hidden live panels, older active runs,
page failures, duplicate clicks and project changes during a pending request.

Dashboard, contracts, SDK and database typechecks passed. The API typecheck still
reports the four Cloud SDK signature errors listed above. The broader SDK test run
recorded 170 passing cases and two failures in host source-file permission tests;
the backup-specific native cases passed. This does not certify the entire release
gate as green. The isolated Docker profile and its test fixtures were removed after
verification.
