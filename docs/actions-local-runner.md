# Openship Actions implementation

Actions runs GitHub-compatible workflow files on authorized connected servers or
disposable Cloud VMs. It has its own workflow/run/job records and topology view;
Jobs remains the module for scheduled commands against existing applications.
The original local-only proposal is superseded by this implementation.

## Shared execution

The platform controller plans dependencies and matrices, rechecks authorization,
leases jobs and stores durable status and masked logs. The packaged Go worker
uses the pinned `act` engine for steps and actions. We do not maintain a second
shell-step interpreter or GitLab Runner syntax translation.

`acquireServerExecution` selects the connected-server adapter;
`CloudWorkspaceExecutor` selects Oblien's authenticated Runtime API. Both feed
`ActionsWorker`. Provisioning a temporary VM is Cloud-specific; workflow semantics,
worker protocol, cancellation and recovery are shared. A controller restart
inspects the same attempt and never silently replays an accepted start.

Connected macOS hosts select native execution by default, including Macs that
also have Docker. Git and Node must be present; jobs use the connected user's
installed toolchains. Linux container jobs require a Docker-capable destination
and the selected runner image. Capability-derived OS and architecture labels
prevent an incompatible server from being advertised as another platform.
Native execution is for trusted code: it has the connected user's host access.

Container runners record the Docker daemon's architecture separately from the SSH
host and advertise x64/ARM64 only after verification. The shared Docker emulation
adapter installs the pinned upstream binfmt helper only on an explicit server-admin
request or during private Cloud VM preparation. Setup mounts binfmt in the Docker
host's mount namespace so registrations survive the installer container exiting.
A pinned foreign BusyBox executable verifies QEMU through the same executor;
routine probes use cached images without
privileges, host mounts or network access. Runner selection and execution both check
capabilities. Each worker receives the concrete Docker platform and propagates its
architecture through act's request context, including `runner.arch` and `RUNNER_ARCH`.
The physical host architecture still selects the packaged worker binary.

Default runner images are overridable per job with normal `container` YAML. Docker
access is opt-in on persistent servers. A Cloud job may use its private VM's Docker
daemon for build actions; that VM remains the tenant isolation and resource boundary.
Unavailable emulation fails preparation and cleans up the VM instead of keeping a
paid worker in a retry loop.

## Sources of truth

- The repository workflow is the definition; an explicitly saved inline override
  and each run's immutable revision are stored in the database.
- Server probes determine runtime capabilities; user labels cannot falsify them.
- Persisted run/job state and worker event sequence numbers drive the topology,
  step view, logs and GitHub Checks.
- The provider owns Cloud credit usage; see [Actions billing](actions-billing.md).
- Existing authorization, GitHub credentials, backup destinations, execution
  adapters and recurring job infrastructure are reused.

The user guide at `apps/web/content/docs/guides/actions.mdx` documents setup,
permissions, native-host access, supported workflow features and current limits.
The REST/native SDK contract is documented in
`apps/web/content/docs/api/actions.mdx`.

## Verification

The Actions CI gate runs real Docker/SSH workflows on an isolated Linux host and
native worker tests with the race detector on Linux and macOS. Module tests cover
planning, permission boundaries, matrix admission, restart/cancellation races,
GitHub events/Checks, artifact protocols and billing recovery. Live Cloud probes
use separate test namespaces, temporary VMs and verified cleanup. Do not claim a
complete GitHub-hosted runner image or unsupported workflow features: reusable
workflows, Windows, OIDC and protected environments are not implemented.
