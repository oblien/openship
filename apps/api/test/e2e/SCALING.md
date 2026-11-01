# Scaling acceptance tests

The release gate runs three independent journeys with real native controllers,
data and storage on disposable Docker infrastructure. Run one with a reachable
Linux Docker daemon:

```sh
RUN_DOCKER_E2E=1 E2E_SCOPE=scaling-application bun run --cwd apps/api test:e2e
RUN_DOCKER_E2E=1 E2E_SCOPE=scaling-storage bun run --cwd apps/api test:e2e
RUN_DOCKER_E2E=1 E2E_SCOPE=scaling-databases bun run --cwd apps/api test:e2e
```

`E2E_SCOPE=scaling` runs all three sequentially. Application tests need at least
4 GiB of Docker RAM. Database tests need at least 6 GiB of Docker RAM; storage
needs an x86_64 Linux Docker host with KVM (`/dev/kvm`) and at least 8 GiB of RAM
for three independent VMs. Both need 25 GiB of local free disk. All need
privileged containers and internet access
to the pinned software releases, image registries and Linux package mirrors.
Fixtures use the product's Docker socket discovery, including Docker contexts
and `DOCKER_HOST`. They never start a daemon or reclaim unrelated disk space.
The application and database containers share the Docker host's kernel. CI
disables swap on its disposable runner; the local harness leaves host memory
settings unchanged. Storage VMs have their own kernels and no configured swap.
On machines without x86 KVM, run the entire storage check through Actions:

```sh
gh workflow run scaling-e2e.yml --ref main -f journey=storage
```

The application fixture creates its own Docker network, an authenticated image registry,
one K3s control node, two workers, and OpenShip Edge. Published test ports bind
only to loopback. It uses a migrated, in-memory database and a test owner/PAT.
It never uses the developer's kubeconfig or registered servers. Cleanup removes
only the fixture's containers, volumes, network and fixture-built images.
Downloaded base images may remain cached.

## Application journey

`scaling-full-cycle.e2e.test.ts` exercises:

- Real MCP discovery and JSON-RPC dispatch, HTTP authentication, project cluster
  selection and deployment admission. MCP uses the same engine paths as the SDK.
- Source build, authenticated image publication and pulling on different nodes.
- Deployment progress over SSE, disconnect and reconnect without duplicate work.
- Public requests through the shipped Edge and the production route writer.
- Scaling from one to three instances and back through MCP, without rebuilding;
  stale deployment/timestamp guards are rejected.
- Internal DNS and Service access from an actual application pod.
- Environment changes, an application update and retained-image rollback through MCP.
- Requests during scale, update, rollback and failed deployment operations.
- MCP cancellation, a real crashing workload and explicit redeployment.
- Worker unavailability and recovery, plus Kubernetes replacing a deleted pod.
- Refusing deletion while volume claims or unfinished file cleanup remain, including
  force-orphan attempts, while the application continues serving requests.
- MCP project deletion, owned namespace cleanup and removal of its public route.

The crash test shortens the workload's native progress deadline to 20 seconds.
It reloads and conditionally patches the Deployment because the controller can
update its resource version concurrently. Kubernetes still produces the failure;
the test never fabricates a status or blindly retries an ambiguous mutation.
During worker loss, it waits for Kubernetes to detect the unavailable node and
remove its Service endpoints, then requires twelve consecutive public requests
to succeed within two minutes. It records interrupted requests during routing
convergence and checks that successful replies come from surviving nodes.
It does not assert instant failover or uninterrupted traffic during a host outage.

Infrastructure location is the only substituted production seam: the resolver
connects the real Kubernetes and Docker adapters to the disposable lab instead of
SSH hosts. The suite starts at a verified server cluster. It does **not** prove
the SSH/systemd installer, provider firewalls, WireGuard provisioning, a
three-control-server quorum, controller-process crash recovery, browser clicks
or ACME issuance.

## Shared storage journey

`scaling-stateful.e2e.test.ts` creates three isolated Linux/systemd/SSH VMs. It
uses the production host installer and API to enable scaling and shared storage,
with version resolution pinned for repeatability. It checks:

- Real SSH preparation, cluster installation, private DNS and service tests.
- Idempotent setup requests and saved SSE progress for scaling and shared storage.
- Two independent copies of shared files and the owned expandable storage class.
- Application mounts on different servers: one instance writes and another reads.
- A real backup to an isolated S3-compatible store, backup scheduling, volume
  growth including the mounted filesystem, and rebuilding a deleted disk copy.
- Source-volume deletion, archive discovery and restoration into a new volume.
- Reading restored file contents, removing owned storage, and preserving external
  backups through the official uninstaller.

Each VM boots a checksum-verified Ubuntu cloud image, with independent OS and
storage disks in labelled fixture volumes. Independent kernels are necessary:
Linux's iSCSI control socket exists only in the initial network namespace, so
separate Docker namespaces cannot represent separate iSCSI hosts. QEMU runs
inside a disposable wrapper with the fixture network and forwarded SSH ports;
no host interfaces or host disks are changed. Local-host
convenience detection is explicitly disabled for these fixture rows so host
commands cannot run on the developer's operating system. Application deployment
uses the production workload adapter; public routing and the complete application
deployment pipeline are covered by the separate application journey.

## Database journey

`scaling-databases.e2e.test.ts` uses one disposable control node and eight workers.
The control node is kept unschedulable so data-node outages cannot remove the only
test API. Operators, database images, backup Jobs and object storage are real. The
production database task image is built from the current tree and imported into
all nodes, so acceptance does not depend on publishing the release first. It checks:

- PostgreSQL creation, private authenticated queries, growth from three to four
  instances, primary loss/recovery and preservation of a committed row.
- A PostgreSQL 17-to-18 logical copy with verified data and server version,
  explicit connection replacement, and preservation of the original database.
- PostgreSQL physical backup/restore, stopping with retained data and explicit purge.
- Redis growth from three to four shards and back with key verification, followed
  by primary loss and recovery of a replicated value.
- Redis archives and recovery into a separate standalone database, including key
  values and absolute expiry times.
- Real Docker PostgreSQL and Redis sources captured with the existing backup
  producers and incremental uploader. Saved artifacts are imported through the
  API while the application is still on Docker, then the matching cluster and
  database connection can be selected.
- Numbered Redis databases preserved in a standalone import, and an invalid
  checksum failing before tables are loaded into a PostgreSQL target.
- Idempotent admission, saved progress, source preservation and cleanup.

Source-backup records are seeded from actual uploaded artifacts. The full backup
scheduler/API capture journey remains covered by the existing backup E2Es.
New data-check pods wait for authenticated connectivity before executing their
data commands once. Only read-only connection checks are retried while the
cluster applies network policy to the new pod.
Importing a database does not automatically convert Compose services, host mounts
or Docker private links. Selecting a new app target and applying its deployment
remain separate reviewed actions. Redis archives are consistent per shard rather
than a transaction spanning the entire cluster.

## Release gate and validation boundary

`test/modules/mcp/mcp-infrastructure-cycle.test.ts` separately exercises native
network registration/verification, compute-cluster creation, k3s setup failure,
idempotent reattachment, retry, status/logs and dependency-ordered removal through
MCP, real authorization, the database and engine. That fast integration fixture
substitutes host adapters and scheduling; it does not prove SSH installation on
real hosts. Policy-driven autoscaling and live worker joining are not implemented.

The release gate calls `.github/workflows/scaling-e2e.yml` and requires all three
jobs before publishing. Routine pull request and `main` CI runs keep the
unit/integration tests and typechecks; they exclude these heavier journeys.
They also run manually from GitHub Actions or with the commands above. Time limits
are 30 minutes for apps, 80 for storage, and 105 for databases, including cold
downloads and recovery waits. These are ceilings, not expected durations. Each
job saves separate diagnostics. A missing daemon, failed pull, setup failure or
assertion fails the job.
A failed step stops its dependent journey and runs cleanup. The other CI matrix
journeys continue, and every journey must pass before publishing.

The latest native shared-storage and database-recovery additions have not completed
a local acceptance run. Passing focused tests and the earlier application E2E is
not a substitute for running those native jobs before release. Fixtures do not
establish provider firewalls, managed WireGuard setup, mixed CPU architectures,
production failure domains, browser journeys, ACME or arbitrary controller/SSH
interruptions. Live infrastructure acceptance is still required.

Check the tests' types separately from the API's source-only typecheck:

```sh
bunx tsc --noEmit -p apps/api/tsconfig.scaling-e2e.json
```
