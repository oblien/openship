# Openship Actions worker

The independent controller wraps [act](https://github.com/nektos/act), pinned to **v0.2.89** (MIT).
The Openship controller validates and schedules workflows; one worker executes one
concrete job with act. The worker runs on the selected destination, never in the
API process.

The GitHub controller uses the same worker supervisor with the **official GitHub
Actions runner**. It downloads an official release with a verified SHA-256 digest,
registers it ephemerally for one repository job, and runs it unmodified. GitHub owns
workflow scheduling, credentials and results; this adapter owns its destination
process and cleanup. Both modes use `ActionsWorker` and the same provisioning and
capacity accounting.

## Build and test

Development needs Node 22 and Go 1.26.4. Installed Openship instances receive the
compiled workers and do not need Go.

```sh
node packages/actions-runner/build.mjs
node packages/actions-runner/test.mjs
```

The build produces Linux and macOS binaries for x64 and arm64, a checksum manifest,
and dependency license notices. API, CLI, SDK and Desktop packaging use the same
asset manifest. The adapter verifies the selected binary before copying it to a
destination.

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
approval and disposable Cloud workers in independent mode; they receive no stored secrets or write
token. Containers alone are not advertised as an isolation boundary for hostile
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
