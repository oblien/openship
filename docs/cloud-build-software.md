# Shared public build images

Managed Docker workspaces can attach a versioned, immutable software-library disk
without changing their `oblien/docker:29` base image. The disk holds public OCI
images, not a shared Docker or BuildKit database. Customer source, dependency
downloads, build output and writable cache volumes remain private to each project.

After the provider has published and verified the `docker-build-cache` preset on
every eligible Docker node, configure the SaaS API:

```dotenv
OBLIEN_DOCKER_PRESET=docker-build-cache
```

This selects the preset only when creating a new managed workspace. It does not
stop, attach disks to, migrate or rebuild existing workspaces. Removing the setting
restores ordinary creation; already-created workspaces keep their pinned software
revision. Keep the setting stable while a workspace creation request is unresolved,
so its provider idempotency key continues to describe the same request.

Redeploying the SaaS API does not attach the disk to an existing Cloud space. Build
logs now report when the shared image pack is unavailable; a new project's private
BuildKit cache can still start empty and then be reused by later builds. The public
image pack and that private cache are independent.

The provider uses its existing software catalog, owned disk references, attachment
permissions, placement checks and boot readiness. Software storage is platform
owned; private writable build-cache storage keeps its existing limits and cleanup.

## How a build uses the disk

Openship checks for a read-only mount at `/opt/oblien/build-cache`, validates its
bounded manifest and checks that the image layout and blobs exist. For literal,
native-platform `FROM` references, it re-reads the current registry digest. Only
an unchanged digest permits a `--build-context` pointing at the pinned local OCI
image. BuildKit verifies and reads those bytes through its normal client session.

The first pack covers Bun 1.3.1, Bun 1.3.14 and the Node 22 digest present when it
was prepared. A later Node 22 tag update becomes a cache miss until a new pack is
published; it never silently selects an older Node version. Image preparation
checks the original runtime configuration and every layer digest and size.

Missing disks, unsupported metadata, missing blobs, changed registry tags and
unavailable digest checks fall back to normal registry resolution. Explicit
platform selection, custom Dockerfile frontends, dynamic `FROM` expressions and
unmatched image references retain their ordinary behavior. Builds can combine a
matching public image with an uncached image in the same multi-stage Dockerfile.

Registry metadata checks can still use the internet. Local layer reads,
decompression, dependency installation and Docker image export still take time.
This is not a promise of offline or instant builds. Existing per-project cache
reuse makes subsequent builds faster independently of the shared image pack.

## Verification

The existing staging smoke can select the published preset:

```sh
bun packages/adapters/scripts/verify-cloud-docker.ts \
  --staging-env /path/to/test-credentials.env \
  --preset docker-build-cache \
  --public-domain preview.oblien.com
```

Use a wildcard domain authorized for that test account. The smoke creates its own
bounded namespace and workspace, verifies OCI use in a real multi-stage build,
then exercises ordinary container, route, volume and restart behavior and cleans
up its exact resources. It never tests against an existing customer's workspace.

The provider's preparation, save, publication and replication procedure lives in
its Docker build-software operator guide. Publish a new immutable revision for
updates and retain older revisions while any workspace references them.
