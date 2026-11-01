# Build cache

Docker deployments retain reusable build state independently of release images.
Deleting a deployment image does not mean the corresponding BuildKit cache must
be deleted. Release retention still protects active, pinned and rollback images.

## Generated builds

On compatible BuildKit hosts with supported stock build images, generated Dockerfiles mount package download caches
for npm, Bun, pnpm, pip, pipenv, Poetry, uv, Composer, Bundler, Cargo,
Go, Maven, Gradle, NuGet and Hex. Known pure framework caches and Turborepo's local
cache use the same mechanism. These mounts do not become application image layers.

Cache identities include the project, repository, branch, app root, build image,
package manager and runtime selection. Compilation cache identities also account
for commands and build environment. Commit and session IDs do not create new
cache namespaces. BuildKit uses content checks for layer reuse; each tool remains
responsible for invalidating its own cached entries. Environment values are hashed
in mount identities and are not written to cache ownership labels or logs.

A cache mount being restored is not a guarantee that a particular task will hit
its cache. Turborepo must actually be invoked, and its task inputs, environment
dependencies and outputs must be declared correctly.

Installation and build commands keep their original order and source context.
Generated Dockerfiles are excluded from application copies so session-specific
filenames do not invalidate unchanged source layers. Existing ignore rules remain.
Custom install scripts can need source files, so OpenShip does not automatically
move them ahead of the source copy. Installed dependencies, compiled executables,
`.nuxt` and other required outputs are not automatically mounted as caches.
Repository Dockerfiles remain the source of truth and can declare their own cache
mounts. Native/bare builds are unchanged.
Custom build images retain layer caching without automatic cache mounts, preserving
their configured users, home directories and any preseeded offline dependencies.
Yarn package archives also stay in image layers: both Classic and modern
Plug'n'Play loaders can need the global cache at runtime. Yarn builds still reuse
Docker layers and supported framework/Turborepo build-only caches.

Legacy Docker builders use the original recipes. Engine-API builds with explicit
CPU/RAM limits also retain their original builder behavior; enabling cache mounts
must not silently remove those limits. Set `OPENSHIP_BUILD_CACHE_MOUNTS=false` on
the OpenShip API/worker, or in a project's build environment, to disable automatic
mounts. This also accommodates custom clean scripts that remove entire mounted
cache directories. Docker layer caching remains available.

## Remote worker lifecycle

Each project has its own BuildKit state volume, labeled as build cache rather
than application data. Temporary workers stop after successful, failed and
cancelled builds. Their CPU/RAM limits are still applied on each recreation.
Recovery verifies both legacy and current workers have stopped before releasing
build capacity. Older unlabeled state is never adopted as a managed cache.

Cloud and SSH server Docker builds require the managed host executor, rootful
Linux Docker, Buildx, and the versioned `openship-buildkit` image. SSH logins
must be root or have passwordless sudo for the trusted host cache files.
Only cache filesystem I/O is elevated; repository commands, the build context,
and the Docker client continue to use the login user's executor and context. Missing support
fails before repository build commands run. These paths never fall back to an
unprotected embedded or legacy builder. Desktop uses the same policy when it
controls a remote server. Disabling automatic package cache mounts does not
change this boundary. Local socket/TCP Engine-API builds retain their existing
builder selection and are outside this remote-build protection scope.

The trusted worker entrypoint installs and verifies IPv4 and IPv6 rules before
starting BuildKit, including after a worker restart. Rules live only inside that
worker's network namespace. They block known provider metadata/credential-agent
addresses for both nested build containers and BuildKit itself, including DNS
aliases and host-mode build networking. DNS on port 53 remains available only
at GCE's documented metadata/resolver addresses (`169.254.169.254` and
`fd20:ce::254`); ordinary package internet access is unchanged.
An operator-provided proxy or host service that fetches metadata on a build's
behalf remains outside this direct-destination policy. Untrusted build steps do not receive the worker's
network-administration capabilities, Docker socket, or insecure entitlement.
This is metadata egress protection, not a general sandbox or defense against a
BuildKit/kernel vulnerability. Bare and Kubernetes builds are outside its scope.

### Worker image delivery

`openship-buildkit` is built for amd64 and arm64 by the existing Docker-images
release workflow. It wraps a digest-pinned official BuildKit image with the
shared metadata policy. The workflow publishes this worker first and verifies
anonymous pulls of both architectures against the same policy-label/entrypoint
predicate used at runtime, plus the release commit. Other image tags wait for
that verification. The separate Release workflow requires a successful image
publication receipt for its exact version tag and commit before publishing API,
desktop or CLI bundles. Ordinary npm-only dispatches require that same receipt;
a named resume continues to verify the original already-published release source.
A new GHCR package that is still private blocks publication with package-visibility
setup guidance. If the worker is missing or fails policy-label/entrypoint checks, builds fail with
`BUILD_METADATA_PROTECTION_UNAVAILABLE`; they do not use an upstream fallback.
An API source checkout builds and transfers this trusted image using the same
managed-image delivery as edge/mail, with a development tag derived only from
its Dockerfile, renderer and policy. `OPENSHIP_BUILDKIT_IMAGE`,
`OPENSHIP_BUILDKIT_TAG` and `OPENSHIP_BUILDKIT_BUILD_CONTEXT` are trusted
administrator overrides, never repository/workflow inputs. Custom image authors
must preserve the guard entrypoint and policy. No host firewall rules or Docker
daemon configuration are changed.

Cache collection and worker attachment share the physical host provisioning lock
across API/worker processes. The worker's attached Docker volume then pins the
state while the build runs outside that lock. Collection skips attached volumes
and caches protected by durable pending commands, including a lost bootstrap reply,
and uses non-force deletion as an additional Docker guard. Ownership is checked
again before deletion. Project deletion removes its idle cache regardless of the
application-data volume wipe option.

BuildKit layer records use its normal publication semantics. Tool cache mounts
are mutable: a failed build can update them. They are disposable optimization
data, not release artifacts or a transaction that rolls back every cache write.
New release images keep unique tags; cached builds pass the existing build and
deployment gates before cutover.

## Storage policy

Managed remote-worker idle caches retain at most 10% of Docker’s filesystem, capped at
5 GiB, with a seven-day idle expiry. Collection removes the least recently used idle state first. BuildKit
workers also receive that cache ceiling and a native BuildKit GC target of
20% free space. Attached state and active build records remain protected. Collection runs
before and after builds and in the daily cache sweep. Explicit cache clearing and project deletion use
the same protected collector for both Cloud and SSH destinations. Project deletion handles
deleted-project state; the daily Cloud sweep also discovers ready owned hosts
whose last project was moved or deleted.
Remote-worker collection returns after processing owned project-worker caches. It never
calls Docker Engine's native `/build/prune` endpoint, including when all managed
caches are attached or protected. Engine-only cache filters are rejected rather
than silently pruning a different cache. On fuse-overlayfs, embedded BuildKit
cache sizing can exhaust the application daemon's memory; a request timeout
does not guarantee that the daemon stops this work.

Existing native builder state is not automatically deleted or quarantined.
Hosts already affected by embedded BuildKit background GC need operator recovery;
this change prevents Openship from requesting native pruning or adding new Cloud
builds to that state. Docker's own embedded GC configuration and daemon supervision
remain host responsibilities. Project cache retention still runs independently.

Openship's build and monitoring requests do not rewrite daemon configuration or
restart Docker. Docker's autonomous embedded GC and the project workers' GC are
configured independently; see [Docker's GC configuration](https://docs.docker.com/build/cache/garbage-collection/).

Native Docker caches use the existing 5 GiB daily retention target, with an
additional bounded prune before Docker builds on their actual daemon. Docker
protects active build records. Ordinary native maintenance failures are logged
without rejecting a build; disk pressure must still be resolved before proceeding.
When a build host executor is available, free storage is measured on Docker's
filesystem. Disk pressure triggers unused-cache cleanup; a build is refused when
free storage remains below 10% of the filesystem, capped at a 2 GiB reserve, or
when supported inode statistics confirm exhaustion. Filesystems without meaningful
inode totals, such as Btrfs, are treated as having unknown inode availability;
the free-space check still applies. Cloud state collection sizes only recognized
cache volumes, avoiding scans of application/database volumes.
Attached or command-protected caches are not walked for size while their files
can change. They enter the reclaimable retention budget after confirmed exit;
project deletion sizes only the requested project's idle state.

These are GC targets and admission checks, not filesystem quotas: active builds,
images and application data can exceed the cache target. Concurrent builds and
application writes can consume space after a measurement. The collector does not
delete active or retained release images, database volumes, or arbitrary Docker
resources to make a build fit. The existing release-image retention collector
continues to remove expired managed images separately.


## Automatic rollback artifacts

A project without an explicit rollback count uses **Automatic** retention. The
instance default (initially five past releases) is a ceiling. On Docker hosts,
existing retention reconciliation also reclaims eligible historical artifacts
when Docker’s filesystem has less than 20% available space. This is shared free
space on the actual host or Cloud space, not a separate allowance per project.

The existing deployment-admission/retention lock covers selection and removal.
Cleanup defers while deployments or role handovers are unsettled. It considers
oldest retained releases first, measures fresh available bytes after each
successful reclaim, and stops once the target is met or measurement is unknown.
It does not estimate reclaimed bytes by adding Docker image sizes: shared layers
make that arithmetic misleading.

Pressure cleanup never stops or removes containers or volumes. It protects
active, pinned and reconciling releases and shared references, and only selects
project-owned generated images or managed static release files. An image still
referenced by a container is refused by Docker; failure keeps its artifact marker
and stops additional pressure eviction so recovery can retry safely.

Only releases that the existing restore planner can recover from a saved Git
commit/configuration or an immutable registry digest are eligible. Upload-only
sources, missing historical configuration, and legacy redacted credentials stay
protected. Deployment history and frozen configuration are preserved. Rollback
uses the normal rebuild/reacquisition path when the local artifact is absent;
source or registry availability is still required.

This runs after successful, failed and cancelled workers acknowledge completion,
when retention settings change, and in the existing artifact-cleanup job. It does
not introduce a cleanup worker or hold a lock throughout a build. Projects using
other runtimes keep their existing count-based behavior. Explicit project counts
and pins remain authoritative; **Automatic** in the shared project/wizard
settings clears an explicit override.

The 20% free-space target is a cleanup policy, not an additional admission limit
or a promise that a build will fit. Running workloads, protected artifacts and
active build layers can use the remaining disk; failed builds retain the current
release. No customer plans, daemon configuration or running services are changed.
