# Builds and application lifecycle

The platform's deployment pipeline selects Docker or bare execution from the
project and destination. Catalog apps and repositories use the same service
build/deploy orchestration; Cloud changes transport, not orchestration.

| Engine | Build execution | Application |
| --- | --- | --- |
| Docker | Dockerfile or generated image build on the selected daemon | Docker container |
| Bare | Shared `runBuildPipeline` through the target executor | Supervised host process or static release |

Managed Cloud supplies its Docker bridge or `CloudWorkspaceExecutor`. A source
upload uses an authorized transfer callback; Git and build commands run on the
target. Static builds retain the release directory; provider edge publication is
owned by `CloudInfraProvider`. A retained-image rollback skips the build.

## Progress and failure

`BuildLogger` owns step events and command logs. The platform persists deployment
and service states, broadcasts progress, and reports the original build/deploy
error. Runtime code returns a failed result or throws when commands fail; it does
not report success merely because an asynchronous request was accepted.

Bare process lifecycle delegates to `ProcessSupervisor`. Host supervisors retain
their own stop/start semantics. `CloudProcessSupervisor` creates labeled provider
workloads, verifies their saved configuration and observed state, and keeps
retired releases disabled across server restarts. PID usage checks include the
process start time to avoid measuring a recycled PID.

## Capacity and ownership

Docker CPU/memory limits are per-container ceilings. On managed servers, source
builds use measured available capacity within the purchased host and are
coordinated with other host activity. No application build creates or resizes a
provider VM. Bare processes share host capacity; the UI does not present Docker
container limits as enforceable bare-process limits.

Build cancellation disposes the active transport and stops its owned build work.
Application deletion and retention remove project-owned releases, containers and
images. Persistent data follows the user's explicit deletion/restore choice and
is not overwritten by a code rollback. Host lifecycle belongs to the subscription
and cannot be invoked by project cleanup.
