# Railway and Vercel migration

New Project → Import existing project offers Server or Docker, Railway, and Vercel. Server imports keep their existing flow. Provider imports use Settings → Connections, the normal destination selector, and the existing migration run, project, deployment, connection, and backup/transfer operations.

## Connect and review

1. An organization admin adds a Railway or Vercel connection in Settings → Connections or directly in the import flow. Existing registry and DNS credentials remain on the same page. Old `?tab=credentials` and `?tab=dns` links still work.
2. Select a project and environment. Railway discovers services, deployed revisions, variables, domains, and attached volumes. Vercel discovers a production or latest ready preview deployment and its GitHub source, build configuration, variables, domains, and PostgreSQL URLs.
3. Review all services in the Railway environment together, one destination project name, distinct service names, a managed plan or connected server, and whether to copy storage or explicitly start empty. Each source project becomes one OpenShip project containing its services; importing a second source project creates a separate project. An external PostgreSQL connection can also remain with its current provider. Supply non-exportable secrets and resolve unsupported provider references.
4. Review checks source compatibility, repository access and destination access. The plan expires after 30 minutes. Starting rechecks the provider inventory; changed configuration requires a fresh discovery. Source admission is reserved transactionally by Railway project and environment, across destinations and connection records.
5. Allow Railway project downtime and pause external deployment automation. The worker prepares the selected managed Cloud host before source downtime, creates one destination project with native services, disables automatic push deployments, stops the entire source environment and copies its volumes before deploying the destination. Private addresses resolve through the services' native aliases on the project network. Environment values are encrypted and scoped per service. Named volumes include the service name and use the normal project namespace, keeping databases and separate projects isolated.
6. Follow progress, logs and the project link at `/migrations/<id>`, including after a browser refresh. Review **Domains & DNS**: each saved source hostname is associated with its service. Custom domains and aliases are already added through the same `saveMigrationRoutes` path used by server/Docker migration, initially unverified. Provider-owned Railway and Vercel URLs require replacement addresses and updates to clients, OAuth callbacks and webhooks. **Review domains & DNS** opens the native project Domains & Routes flow. Test the destination, apply the exact DNS records shown for Cloud or the destination server, then verify DNS, HTTPS and application traffic before confirming completion. Retire the old provider resources separately.

Domain guidance reuses the public `domains` inventory and its `portable` flag, persisted in the
run's input snapshot. Route persistence validates hostname ownership before stopping the source;
cross-project claims and invalid routes stop admission. It never reconstructs DNS records from source hostnames or mutates DNS during
import. The existing Domains & Routes flow owns route configuration, DNS records, supported
provider automation and verification. The same guidance is shown before admission and when
reopening a saved run; confirmation remains an operator acknowledgment, not an automated DNS check.

## What transfers

| Source              | Supported                                                                                                                                                                                                                      | Explicit review or separate work                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway             | Complete project environments, GitHub repositories at the deployed commit, custom Dockerfiles, portable registry images, build settings, HTTP readiness, restart policy, variables and all selected persistent volume contents | Sealed secrets, unresolved references, dependency cycles, incompatible Git sources, scheduled jobs, multiple replicas, pre-deploy commands, multiple public ports, private registry access and provider-specific features |
| Vercel              | GitHub source at the deployed commit, build/root/output settings, exportable environment values, discovered domains, external PostgreSQL connections                                                                           | Non-exportable Secret/Sensitive values, functions and provider APIs requiring application changes, Edge Config, Blob, other storage services, and non-GitHub repositories                                                        |
| External PostgreSQL | A logical copy of the configured database to the selected major version, or preservation of its external connection                                                                                                            | Other databases, roles, provider authentication, extensions unavailable in the destination image, pooler/client settings and non-public source endpoints                                                                         |

Railway uses the existing bounded `transferVolume` stream for every persistent mount. There is no database-type dispatch in this path. The worker stops every source workload, temporarily applies a minimal export-only image on the existing mounts, then restores the original configuration without starting the source. It does not detach volumes: Railway volume reassignment can redeploy the original application, which would invalidate a stopped copy. Data includes all persisted database files, accounts, queues, SQLite files, permissions and symlinks, without a per-record size limit. Ephemeral container layers and external storage are not volume contents.

The destination uses compatible application images, pinned to the running digest when available; otherwise Review warns that the mutable tag may have changed. A volume copy is not an engine upgrade. Empty destination volumes are checked for ownership before writing, and every imported runtime must pass the normal container stabilization check even if its deployment completed with warnings.

Managed Cloud and connected servers use the same import worker and transfer pipeline. Managed host preparation uses the existing subscription provisioning and activity admission; if it fails, Railway stays untouched. Storage names come from the destination's normal volume resolver so import and deployment mount the same volume. Cloud transfers use the owned provider connection, never the SaaS host's Docker socket or filesystem.

External PostgreSQL copies use the shared logical backup producer. Source/target majors and available extensions are checked before restore, and fresh destination databases must finish initialization before receiving data. External writers still require manual quiescence.

Repository imports use ordinary OpenShip source-service build recipes. Each provider service remains one native service, including explicitly discovered workers. A native project has one Git source: services using different repositories or deployed commits must be aligned before review can succeed. Repository-wide release commands require a service-compatible recipe; review blocks them instead of silently skipping their release phase. Railway pre-deploy commands, cron, replica topology, unsupported Vercel configuration and invalid paths also block review. Railway sleeping services become continuously running services, with a review warning.

Vercel cannot export Secret/Sensitive values. After entering a missing PostgreSQL URL, Review adds its database to the same choice list. It stays external unless the user chooses to copy it. Copies require a direct public PostgreSQL URL with TLS and a source database role permitted to export its contents. DNS is validated and pinned; the client runs inside the destination database container.

## OAuth configuration

OAuth is available only when the installation has a registered provider application. Otherwise the same connection form offers API tokens; the UI does not present an unconfigured OAuth button.

Configure these server-side environment variables:

| Provider | Variables                                                                                                                         | Provider setup                                                                                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Railway  | `OPENSHIP_CONNECTION_RAILWAY_CLIENT_ID`, `OPENSHIP_CONNECTION_RAILWAY_CLIENT_SECRET`                                              | Register an OAuth application with the exact dashboard callback below. Requests Authorization Code + PKCE with `openid email profile offline_access workspace:member`; rotating refresh tokens remain encrypted.                           |
| Vercel   | `OPENSHIP_CONNECTION_VERCEL_CLIENT_ID`, `OPENSHIP_CONNECTION_VERCEL_CLIENT_SECRET`, `OPENSHIP_CONNECTION_VERCEL_INTEGRATION_SLUG` | Register a Vercel API integration with an external installation flow, read access to projects, deployments, domains and environment variables, and the exact callback below. The returned installation token and team scope stay together. |

The callback is `<canonical-dashboard-url>/connections/callback`, using Openship's existing public dashboard URL configuration. Register that exact origin/path with both providers, including for local testing. Never put client secrets in public dashboard environment variables.

Railway tokens may be scoped to an account, workspace or project/environment. Workspace tokens also require the workspace ID. Vercel team tokens require the team ID. Data export additionally needs Railway SSH-key registration and access to the selected running service; a metadata-only token is not sufficient for copying volumes.

Organization connection grants are separate from user sign-in identities. Better Auth continues to authenticate Openship sessions. The Connections module stores provider tokens in the existing encrypted credential records, binds authorization state to the initiating session/user/organization, consumes it once, and serializes refreshes through the shared database lock. This avoids storing organization grants as a user's login account.

## Failure and recovery

Provider imports never delete source services, change source domains, or disable source database authentication. Railway imports stop the entire selected environment. Operators must pause external deployment automation; Railway does not provide a lock against simultaneous changes made outside Openship. Staged changes, unexpected deployments and configuration drift block the transition instead of being silently overwritten.

Each import owns a temporary Railway SSH key. Grant intent is persisted before registration; recovery can find that exact public key after an ambiguous response and revoke it. The existing migration recovery job retries incomplete cleanup after interruption. Connections cannot be deleted or have their tokens changed while a migration or grant cleanup still needs them.

Railway checkpoints save mutation intent, original configuration and deployment identities before pausing the source. They recover export containers even after a lost API response. Failed imports retain copied data and project configuration, stop every destination workload started by that import, then restore the original source deployment images. Recovery holds the existing destination runtime locks until source restoration finishes. An operator redeploy or unreachable destination prevents automatic source resumption until reviewed. Successful copies leave the source stopped for cutover. Partial destination volumes are not overwritten on retry. Recovery configuration is never returned by run APIs; the encrypted plan is cleared after successful import or completed failure cleanup.

## Verification

Provider fixture tests cover discovery scopes, pagination, sealed variables and output redaction.
Import tests cover review binding and drift, exact Git revisions, destination preparation before
source downtime, database-first ordering, transfer failures, cancellation and owned SSH-key
recovery. Database tests exercise multi-project migration locks and pending cleanup guards.

### Grouped project verification — 2026-11-12

`apps/api/test/e2e/platform-import-project.e2e.test.ts` imports two projects, each with
two Redis services and a worker, through both Docker and Cloud runtime adapters.
It uses the real migrated control database, review planner, import worker, encrypted
service environments, volume transfer and native Compose deployment engine. Both
projects deliberately reuse the same service names: assertions check project and
service counts, private DNS, separate secrets and volumes, copied data and new writes
after restart. The worker also serves an HTTP health endpoint: its imported custom
domain and alias retain the correct service/port and remain unverified, while its
Railway-owned URL is excluded. Persisted routing tests additionally cover Cloud-owned
targets, idempotent domain staging and cross-organization hostname conflicts. Public
DNS cutover is not exercised by these fixtures. The provider control/SSH boundary and asynchronous build queue are
substituted. The Cloud provider tunnel connects to the test Docker daemon; this is
not a live SaaS test.

A live Railway project with two Redis volumes and an Alpine worker also passed
discovery, SSH access, whole-project pause, cold copy, grouped native deployment,
private service connections and restart persistence on a local Docker destination.
The original Railway images and commands were restored with the source workloads
stopped, and its temporary SSH
key was revoked. The disposable project was removed after verification; the existing
user project was retained. Railway's account resource limit prevented a second live
project, so simultaneous two-project isolation is covered by the repeatable Docker
suite above. Sanitized live evidence is
`/tmp/openship-railway-grouping-live-evidence.json`.

The grouped flow then passed a separate **live Railway → OpenShip Cloud** run on
a real managed VM (2 vCPUs, 4 GB RAM). This used the current engine in Cloud mode,
the normal saved-credential verification, namespace token issuance, managed host
provisioning, volume transfer, deployment admission/queue and runtime. One source
project became one destination project with all three services. Both Redis datasets,
encrypted service environments and private DNS were verified on the Cloud VM.
After new Redis writes and per-service environment changes, a normal redeployment
replaced all three containers; the original data, new writes, updated environments
and service connections all remained correct. Source configuration restoration and
temporary SSH-key revocation were also confirmed. Only subscription entitlement
was a test fixture; this does not verify checkout or browser sign-in. Sanitized
evidence is `/tmp/openship-grouped-cloud-live-evidence.json`.
The disposable Cloud VM, namespace and Railway project were removed after the run.

### Live API and data verification — 2026-11-11 (UTC+2)

These historical runs predate project grouping; the current grouped-flow checks are
documented above.

| Direction                       | Result                                  | Verified workload and behavior                                                                                                                                               |
| ------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway → SSH server            | Passed                                  | Four services: PostgreSQL, Redis, SQLite and files; private connections, new writes and recreation of all services through the normal deployment API                         |
| Railway → Cloud                 | Passed                                  | Whole three-service environment: PostgreSQL, Redis and a Python app with SQLite/files; all three destination containers recreated, with new writes and connections preserved |
| SSH server → Cloud              | Passed                                  | Three-service Docker project, including a locally built image; PostgreSQL records, Redis payload, SQLite records and file checksums matched                                  |
| Cloud → SSH server              | Passed after the image-stream fix below | The existing Cloud containers were imported through the normal server-import API; all data matched, then new writes survived redeployment                                    |
| SSH server → another SSH server | Passed                                  | The imported project moved through the owned-project move API; its new writes and private connections survived                                                               |
| Vercel → either destination     | Not live-verified                       | No Vercel account/project was available; provider fixture coverage is separate from a live migration                                                                         |

The Railway-to-SSH fixture verified 5,000 Unicode PostgreSQL records, a second database with 200
records and a preserved role/grant; a 20 MiB Redis value, TTL and ACL user; 1,000 SQLite records;
and a 2 MiB attachment with matching SHA-256, UID/GID, mode and symlink. Interrupting an import
after pausing the source exercised checkpoint recovery. A separate failed import stopped its
started destination workloads before resuming Railway.

The Railway-to-Cloud fixture compared 502 PostgreSQL and 102 SQLite records plus Redis/file
checksums. New application writes produced 503 and 103 records and new Redis/file checksums;
all survived recreation of the PostgreSQL, Redis and web containers. The import reached
`succeeded`, restored the original Railway configuration, left its workloads stopped for
cutover and revoked its temporary key.

The native server/Cloud fixture compared 500 PostgreSQL and 100 SQLite records, a 2 MiB Redis
payload and a 1 MiB file. Writes on Cloud survived the return to SSH. Further writes survived a
normal redeploy and the subsequent server-to-server move. Cloud-to-SSH imported those existing
containers into a fresh control database; the subsequent server-to-server run exercised the
owned-project move route.

These runs used production API handlers, authentication, an isolated migrated PGlite control
database, workers, real SSH Docker hosts, live Railway resources and an actual Cloud VM. The
Cloud subscription/link authority was a test fixture. They do not verify SaaS browser sign-in,
billing checkout, registered OAuth applications, Git source builds or public DNS cutover.
Cloud-to-external-server control ran in desktop/self-hosted mode with a linked Cloud workspace.
The SaaS API still requires a managed destination; its host-execution and ownership guards were
not relaxed for testing.

### Storage compatibility

Independent stopped-volume tests passed PostgreSQL 17, Redis 7 with AOF, MySQL 8.4, MongoDB 8
and an unrecognized Python/SQLite app. Each starts the compatible original image on copied
storage, compares data before and after restart, preserves ownership/modes/symlinks and rejects
overwriting a populated destination. The production transfer method never selects an
engine-specific exporter.

All five fixtures also passed against a real Cloud VM through `copyPlatformData` and
`CloudDockerRuntime.deploy`. The repeatable real-Docker suite covers normal Docker and Cloud
transports. These tests found and fixed managed-host preparation before downtime and destination
volume identity mismatches. Import and deployment now use the same resolved volume.

### Image-stream reliability

A Cloud-to-SSH image transfer exposed a truncated archive before source downtime. Reproduction
with a slow receiver traced it to the command-output stream closing before all bytes arrived.
Cloud image exports now use the existing authenticated Docker binary transport with backpressure;
SSH retains its native stream. No additional connection or local-host Docker access was added.

The fixed live transfer loaded all 63,514,624 bytes at a capped 512 KiB/s with the expected SHA-256.
The subsequent Cloud-to-server migration transferred the app, PostgreSQL and Redis images and
volumes successfully. Regression tests cover binary bytes with a slow consumer and rejection of
truncated Docker responses. The 23 image-transfer/Cloud-transport tests, API and adapter type
checks, and API production build passed.

Disposable Cloud VMs/namespaces, Railway projects, migration keys, local SSH containers/volumes,
private test harnesses and temporary credentials were removed after verification. The pre-existing
Railway project was retained. Cleanup evidence is `/tmp/openship-migration-matrix-cleanup.json`.

Sanitized local evidence: `/tmp/openship-railway-project-e2e.json`,
`/tmp/openship-cloud-import-e2e.json`, `/tmp/openship-migration-matrix-e2e.json`,
`/tmp/openship-cloud-server-matrix-e2e.json` and `/tmp/openship-railway-cloud-matrix-e2e.json`.

Provider references: [Railway API](https://docs.railway.com/integrations/api), [Railway OAuth](https://docs.railway.com/integrations/oauth), [Railway SSH](https://docs.railway.com/cli/ssh), [Vercel API integrations](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations), [Vercel environment variable types](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types).
