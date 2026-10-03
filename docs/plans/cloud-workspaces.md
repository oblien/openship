# Managed Cloud servers

Approved scope: one subscription provisions one managed server. Projects select
it through `serverId` and use the existing Docker or bare application engine.
Self-hosted, desktop and SaaS share the server acquisition, destination and
application flows. Conversion of customers from the retired Cloud architecture is
performed outside this code. Customer-initiated imports use the shared migration
flow, with migration-only external SSH sources and managed Cloud destinations.

## Invariants

- The organization owns the subscription and managed server. Projects are members;
  deleting an application cannot delete, resize or restore the server.
- `serverId` is the execution selector. Its managed binding determines the
  subscription and provider namespace; clients cannot supply an unrelated scope.
- `DockerRuntime` runs containers. `BareRuntime` runs host processes or serves
  static releases. A separate server provides a dedicated destination; choosing
  bare alone does not purchase or isolate another VM.
- Oblien supplies provisioning, scoped transport, process supervision, networking,
  billing and ingress. There is no parallel native Cloud application engine.
- Workload commands use the destination adapter. An unbound or disconnected Cloud
  destination cannot fall back to the control plane's Docker socket or filesystem.
- Each subscription owns one provider VM. Projects share its CPU, memory and disk;
  optional container limits do not reserve another VM. Builds use available host
  capacity. Stored bytes are measured separately from purchased disk capacity.
- Host operations coordinate across API replicas and linked installations. Intent,
  command completion and deletion receipts are durable; an uncertain remote
  mutation cannot be blindly replayed or unlocked after a timer.
- A linked installation pins the Cloud API, user, organization, subscription and
  server. Switching or disconnecting the account invalidates access and caches.
- Configuration transfers require explicit destination mapping and do not copy
  execution credentials or silently tear down the source deployment.

## Delivered work

- Managed ownership constraints, namespace credentials, subscription reconciliation
  and recoverable provisioning/resize/deletion.
- Common Add Server and destination selection, including acquisition/linking from
  self-hosted and desktop installations without reseller credentials.
- Shared builds, services, environments, jobs, terminals, monitoring, backups,
  rollback and project cleanup; provider-specific routing validates project-owned
  container and process listeners.
- Independent billing for additional servers, measured storage, capability-based
  server controls and activity history.
- Permission-gated HTTP, SDK and MCP operations and generated website references.
- Restored regression tests, complete production-router boot scans, real Docker
  release tests and explicit live-provider verification.

## Verification and limits

Full API, dashboard, adapters, database, core, contracts, platform, SDK, CLI and
script suites pass locally. Cloud and self-hosted production route graphs pass
the startup permission scanner with no unregistered routes. Typechecks,
documentation validation, the website build and public SDK packaging also pass.
The new managed-bare regression reproduces the self-hosted edge-claim error before
its fix; the same suite retains self-hosted collision protections.

The real Docker release suites exercise source-build success/failure/cancellation,
ports/routes, mounts, private links, environment reapply, backups/restores,
retained-image rollback and sibling-safe cleanup. Separate-account Oblien tests
exercise provider transport, process identity, restart/stop/start and teardown.
Local SaaS testing uses a temporary complimentary grant, not a paid checkout.

Actual payment capture, renewal and externally delivered billing webhooks require
staging validation. Simulated billing tests do not certify the payment processor.
An unfinished mutation after a bridge crash requires a provider-console server
restart before recovery; the application does not restart customer services
automatically. Linked application counters may be unknown when records belong to
another installation. These boundaries are documented in
[Managed Cloud servers](../managed-cloud-servers.md).

## Separate earlier audit findings

This work protects the shared server during application rollback. It does not
claim to fix the earlier rollback environment-preview count, general Compose
rollback transactionality, deployment-page rollback shortcut or SSL revalidation
latency. The old SaaS customer's `no space left on device` report also needs the
affected host's block/inode and mount measurements; no customer data was pruned.
