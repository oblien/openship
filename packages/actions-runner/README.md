# Openship Actions worker

The independent controller wraps [act](https://github.com/nektos/act), pinned to **v0.2.89** (MIT).
The Openship controller validates and schedules workflows; one worker executes one
concrete job with act. The worker runs on the selected destination, never in the
API process.

The GitHub controller uses the same worker supervisor with the **official GitHub
Actions runner**. It downloads an official release with a verified SHA-256 digest,
registers it ephemerally for one repository job, and gates the actual assignment
before starting its original Worker binary. GitHub owns
workflow scheduling, credentials and results; this adapter owns its destination
process and cleanup. Both modes use `ActionsWorker` and the same provisioning and
capacity accounting.

The admission adapter uses GitHub's private local Listener/Worker IPC format and
fails closed on unsupported framing, missing identity, cancellation or timeout.
It does not modify the original upstream binaries or interpret workflow steps.
See [Actions access and approvals](../../docs/actions-access.md) for this compatibility
boundary and the policy checks. Retain the IPC tests and real runner verification
when upgrading GitHub's runner.

## Build and test

Product builds reuse the immutable worker image in `artifact.json`. The shared
`stageActionRunnerAssets` loader checks the source fingerprint, protocol, engine,
all four binary checksums and notices. The fingerprint covers compilation and
embedded-script inputs; transport-module, documentation and test-only changes can
reuse the binary release. Desktop, CLI and native release packaging fetch the pinned OCI layer over HTTPS and embed its files; Docker is not required
for that fetch. The API Dockerfile copies the same files from that exact image
digest. Installed products never fetch or compile a worker at startup.

Developing changed worker source needs Node 22 and Go 1.26.4. A valid local build
is reused first. A matching published pin is fetched when local assets are absent;
a failed fetch fails the build instead of silently compiling. Unpublished source
uses the declared Go toolchain. `OPENSHIP_ACTIONS_RUNNER_BUILD=1` explicitly permits
a source build when offline; it still must pass the same verification. Installed
Openship instances receive the compiled workers and do not need Go.

```sh
node packages/actions-runner/build.mjs
node packages/actions-runner/test.mjs
```

For an unpublished worker in a custom API image, build the workers first, package
those files locally, and supply that image to the API build:

```sh
docker build --platform linux/amd64 -f packages/actions-runner/Dockerfile.artifact -t openship-actions-local packages/actions-runner
docker build --build-arg ACTIONS_RUNNER_IMAGE=openship-actions-local -f apps/api/Dockerfile .
```

Both paths use the same staging verification.

The build produces Linux and macOS binaries for x64 and arm64, a checksum manifest,
and dependency license notices. API, CLI, SDK and Desktop packaging use the same
asset manifest. The adapter verifies the selected binary before copying it to a
destination. Destination copies are cached by their SHA-256, rechecked before
reuse and replaced only when needed.

To publish changed worker source, dispatch the existing **Docker images** workflow
on the reviewed branch with `runner_assets_only=true`. That path runs worker tests
and vet, builds all four targets once, and publishes the file-only
`openship-actions-runner:source-<fingerprint>` image without changing any product
image tag. Download its `actions-worker-pins` artifact and commit `artifact.json`
and the API Dockerfile pin together. The image must allow anonymous pulls before
merging; a newly created GHCR package is private by default. Subsequent product
builds reuse the digest, and the shared CI cache is independent of build-host OS
and architecture. Registry layers and binaries are both digest-verified. The required CI test gate
also forces a fresh anonymous install with Go and Docker removed from PATH. Keep the
source-build path for development; never switch a release to a mutable `latest`
worker tag.

The distribution image has no service process or socket mount. The selected
server runs the worker binary. Docker jobs talk to that server's daemon; exposing
its socket inside jobs is opt-in on persistent destinations. The official runner
uses its existing private ownership proxy socket. That proxy tracks cleanup and
limits, rather than sandboxing hostile Docker code. Native macOS execution does
not require Docker.

`prepare.mjs` applies the documented compatibility patches to a private copy of
act. It never edits the global Go module cache. Patches require their expected
source anchors, so an upstream change fails the build instead of silently skipping
an integration fix. Keep patches small and revalidate them when updating act.

## Execution and recovery

`ActionsWorker` uses Openship's authorized execution adapter for prepare, start,
inspect, cancel and clean. It does not spawn user commands on the control plane.
A job's exclusive journal prevents a retry after an uncertain start from executing
the same commands again. The one-use request is mode `0600` and removed after it is
read. It carries scoped credentials through a file, not command-line arguments.

Logs are masked and bounded before persistence. Cancellation records intent,
stops the worker's process group, and reconciles only containers and volumes owned
by that job. Process recovery checks birth identity as well as PID; it must not
signal an unrelated process after PID reuse. The controller releases a runner slot
only after cleanup is confirmed.

Persistent Docker and native runners execute code trusted by their administrator.
Native macOS jobs run as the connected server user. Untrusted fork jobs require
approval and disposable Cloud workers in both modes. Independent fork jobs receive
no stored secrets or write token; GitHub supplies its own workflow credentials.
Containers alone are not advertised as an isolation boundary for hostile
code on a shared, persistent server.

The official runner receives only a short-lived registration token, via private
request/configuration input. Workflow tokens come from GitHub. They are not copied
from the independent controller. A private Docker API socket adds the shared
ownership label and per-container resource limits to GitHub's service/job containers.
It is a cleanup mechanism, not a sandbox against privileged Docker code. The Cloud
VM bounds the aggregate job capacity and is deleted before releasing its slot.

## Compatibility

Independent Openship Actions reuses the upstream workflow parser and act executor. Supported workflows
include shell, JavaScript and Docker actions, composite actions, service containers,
matrices, dependencies, outputs, expressions and concurrency. Reusable workflows,
protected environments, OIDC, attestations and Windows runners are rejected or
unavailable rather than silently emulated. See the Actions user guide for the
current compatibility limits. GitHub mode supports GitHub workflow behavior using
its official runner, including reusable workflows and GitHub-owned Checks. Native
Windows and GitHub Enterprise Server destinations are not implemented.

CI exercises the worker over real Linux Docker/SSH destinations and runs the Go
race suite on Linux and macOS. It covers service-port contexts, cancellation,
recovery, retained logs and cleanup beside unrelated application containers.
