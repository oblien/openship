# Ship SDK workspace

The SDK exposes one authorized platform implementation through native and remote clients. Native calls invoke the shared engine inside an owned Node worker in the host process. HTTP controllers call those same operations. Neither SDK import nor native creation starts an HTTP listener.

This private workspace implements the SDK. `packages/openship` assembles the public `openship` package and CLI. The SDK exports are implemented and tested in the local distribution; publishing the next npm release is separate. The [full plan](../../docs/ship-sdk-plan.md) tracks the remaining platform migration.

The website's [API → Node.js SDK guide](../../apps/web/content/docs/api/sdk/index.mdx) covers installation/release availability, native and remote setup, tenant scopes, deployment workflows, and a [shared SDK/REST reference](../../apps/web/content/docs/api/index.mdx) for the current public groups. The published `openship@0.7.2` is still CLI-only; use a locally built package until the SDK release is published.

The public package includes a runnable [native lifecycle example](../openship/examples/native-lifecycle.mjs). From a Node project with the SDK tarball installed, run `node node_modules/openship/examples/native-lifecycle.mjs`. It exercises real deployments, redeployment, tenant isolation, session revocation, persistence, and project teardown in an owned temporary installation. The [package verification](../openship/verify-package.ts) runs and typechecks this exact example outside the workspace on Node 22 and 24. It uses the bare runtime without public routing; live Cloud, Docker, and SSH behavior are separate checks.

## Owned native integration

This example creates a persistent installation, maps a host identity, and deploys generated files. The session map is owned by this application; an embedding web application should use its own verified session service in `identity.resolve`.

```ts
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createShip, type VerifiedIdentity } from "openship/native";

const sessions = new Map<string, VerifiedIdentity>();
const stateDirectory = resolve("./ship-state");
const ship = await createShip({
  instanceId: "my-product",
  stateDirectory,
  storage: { driver: "pglite", dataDir: resolve(stateDirectory, "database") },
  encryptionKey: process.env.OPENSHIP_ENCRYPTION_KEY!,
  runtime: "bare",
  routing: "none",
  policy: { allowHostExecution: true },
  administration: true,
  identity: { resolve: async (assertion: string) => sessions.get(assertion) ?? null },
});

try {
  const mapped = await ship.operator!.ensureIdentity({
    issuer: "my-product", subject: "customer-123", email: "customer@example.com",
  });
  const assertion = randomUUID();
  sessions.set(assertion, { user: mapped.user, sessionId: assertion });
  await ship.start();
  const customer = await ship.scope({ identity: assertion, organizationId: mapped.personalOrganizationId });
  const submitted = await customer.deploy({
    name: "generated-app",
    source: { type: "files", files: { "index.html": "<h1>Hello</h1>" } },
  });
  const outcome = await customer.deployment(submitted.deployment_id).wait({ timeoutMs: 60_000 });
  console.log(outcome.status);
} finally {
  await ship.close({ mode: "drain" });
}
```

Set a persistent UTF-8 encryption secret of 32–4096 bytes. A database is bound to its `instanceId` and key fingerprint; reopening it with a different identity/key fails. Native storage never defaults to the user's existing CLI database. Runtime files are kept under `stateDirectory/instanceId`; PGlite uses the separately specified `dataDir`. PGlite supports `memory://` for ephemeral installations. PostgreSQL uses `{ driver: "postgres", url, migrations: "verify" | "apply" }` and defaults to verifying migrations.

Host execution is disabled by default. Local builds and managed local routing require `policy.allowHostExecution: true`. `routing: "none"` is available with the bare runtime. Docker, registered SSH servers, and cloud use the existing providers; provider-specific validation and release gates remain in the plan. Generated application code is a workload; a scoped context alone does not sandbox code that the host explicitly allows to run locally.

Directory sources use `{ type: "directory", path: absolutePath }` and must be inside an explicit `policy.sourceRoots` entry. The SDK snapshots the selected files before dispatch. It rejects escaping/cyclic symlinks and special files, enforces size/entry limits, and excludes `.git`, `node_modules`, and `.DS_Store` while retaining build outputs. Remote packing and API relay extraction use a Node library and do not require a system `tar` executable.

`start()` enables operations and optionally configured job/backup scheduling (`jobs` defaults to false). `close()` refuses new mutations, drains calls/deployments/background work, and closes resources owned by that installation. A `timeoutMs` on close only limits how long the caller waits; draining continues. Separate native installations use separate workers and do not mutate the host's environment. Shared-database dispatch leases, durable event replay, and complete scheduler ownership remain unfinished.

## Identities, namespaces, and scope

Trusted host code may enable `administration` to access:

- `operator.ensureIdentity({ issuer, subject, email, name?, userId? })`
- `operator.resolveIdentity({ issuer, subject })`
- `operator.ensureNamespace({ issuer, key, name, ownerUserId })`
- `operator.setMembership({ organizationId, userId, role })`; `role: null` removes membership.
- `operator.notices.listAll()`, `.create(input)`, `.remove(id)` manage installation announcements. Ordinary scopes only have `notices.list()`.

Identity mappings and namespaces persist. Email equality does not link existing accounts; linking requires an explicit `userId`. Existing identity mappings do not gain instance-admin privileges when ensured again. Membership changes cannot remove the final organization owner.

A namespace maps to an Openship organization. Projects belong to that organization and follow the existing role/grant model. Create resources under a customer by obtaining a verified identity, selecting its organization with `ship.scope`, then invoking `customer.projects.create` or `customer.deploy`. The operator is never included in the customer's scoped client.

Every call asks the trusted adapter to revalidate the assertion and rereads membership/grants. The adapter must observe session/token revocation; a permanently cached successful assertion is not an authentication service. Removing membership invalidates an already-created scope. The assertion cannot pick its own role or organization authority. Fixed scopes cannot access another organization's resources even if the same user belongs to both.

For existing scoped PAT/OAuth identities, the trusted adapter returns `tokenScope: { tokenId }` and `credential: { organizationId, readOnly, expiresAt? }` after verifying that credential. The platform reads stored grants and enforces these restrictions. Tenant-bound credentials cannot perform whole-instance operations.

## Remote integration

```ts
import { OpenshipClient } from "openship/client";

const customer = new OpenshipClient({
  baseUrl: "https://ship.example.com",
  token: process.env.OPENSHIP_TOKEN,
  organizationId: "org_customer",
});
const submitted = await customer.deploy({
  name: "generated-app",
  source: { type: "files", files: { "index.html": "<h1>Hello</h1>" } },
  serverId: "registered-server-id", // omit to use the installation's configured target
});
console.log(await customer.deployment(submitted.deployment_id).wait());
```

An explicit organization requires SDK protocol 1 and `fixedOrganizationScope` support, checked before the first mutation. The client sends the fixed scope; the receiving server authenticates the credential and constructs its own context. `client.scope(organizationId)` creates another independent client. Omitting the organization retains the HTTP API's existing resource-derived scope.

`baseUrl` accepts `/api` and reverse-proxy prefixes. `token` may be a function for rotation; `fetch` may be injected. `ApiError` retains `status`, `code`, and response `body`. Mutations are submitted once without automatic retries or redirects. Cancelling a wait stops that wait; use `deployments.cancel(id)` to cancel execution.

Connect directly to the canonical cloud instance and its cloud organization ID. Owner-account links on self-hosted instances do not yet provide a verified tenant mapping, so fixed scopes refuse that forwarding with `CLOUD_SCOPE_UNAVAILABLE`. Existing unscoped HTTP forwarding is preserved.

## Supported shared surface

| Group | Shared functionality |
| --- | --- |
| `projects`, `sources`, `deployments` | Lifecycle, environments/settings, source preparation, builds, runtime controls/logs, decisions/cancellation/rollback, events and deletion. |
| `services`, `domains`, `dns` | Service/configuration/storage/connections and domain/routing/DNS/TLS operations. |
| `servers`, `system`, `credentials` | Server management/install/container streams, profiles, stored credentials and server Git; setup/self-app/edge/terminal coverage is still incomplete. |
| `apps` | Catalog discovery, installs, configuration and connections. |
| `backupDestinations`, `backups`, `jobs` | Policies/runs/restores and streams, destination management, job lifecycle and execution. |
| `analytics`, `issues`, `notifications` | Authorized metrics/issues, delivery channels/subscriptions/verification/history. |
| `settings`, `audit`, `updates` | User settings, audit pages/facets, update inspection/scan/apply. |
| `webhooks` | Incoming hook management/rotation, delivery history and native invocation. |
| `tokens`, `permissions` | PAT/MCP lifecycle, grants/resources, teams/memberships and invitations. |
| `github` | Connection/source management, repository metadata/content/automation and narrowed clone tokens. |
| `notices` | Public installation announcements; publishing requires the separate operator capability. |
| `billing` | Plans, subscription and renewal state, checkout, cancellation/resumption, top-ups, a namespace-specific portal, usage and allowance detail through Oblien. |
| Workflows | `deploy({ source, ... })`, `deployment(id).wait(...)`. |

The exported operation interfaces in `@repo/contracts` are the method-level source of truth. Capability checks depend on mode, configured providers, identity, and host policy.

Native and remote clients share public input schemas, result schemas, masking, actor attribution, and source-to-deployment orchestration. `deploy` returns deployment/project IDs; obtain a handle with `deployment(id)`. Creation results may contain a validated `deployment` record; ID-only results remain supported for HTTP compatibility.

All project methods are on `scope.projects` or `client.projects`. Environment lists honor individual project grants. Environment-variable reads mask secret values; clone-token administration requires project admin permission and returns token state rather than the token itself. `deletionPreview` reports the existing teardown preview; deletion uses the shared teardown operation.

`createShip({ platform, identity })` synchronously attaches to a caller-owned `PlatformKernel`; it does not start or close that composition. Workspace API code supplies the existing kernel from `@repo/platform/engine/lib/platform`. Public embedders normally use the owned asynchronous factory shown above.

Native CLI mode is implemented and the legacy HTTP/SSE/folder-deploy helpers are removed. Edge, mail, and parts of system management still need named SDK adoption. Full mail, data transfer, cloud tenant mapping, organization/account lifecycle, and remaining system/channel operations are still being migrated. Durable multi-worker dispatch/replay, billing replay/accounting review and constrained background jobs remain open.

Billing catalogs work locally. Account and payment operations require hosted billing configuration or the canonical remote cloud client. Fixed local scopes refuse unverified owner-account cloud forwarding. Oblien webhook signature verification remains outside the ordinary tenant SDK; the retired Stripe webhook returns 410. Portal/cancel/resume require billing admin permission and remain available when new purchases are disabled.

Incoming hooks, invitations, and Git device continuations retain the initiating actor's identifiers and restriction ceilings and recheck persisted membership/token revocation before execution. They never substitute an organization owner. Host session revocation must be synchronized into durable identity/membership state for work that can survive the originating request; external assertion callbacks cannot be replayed after restart. Job, backup, and scan principals still need this migration.

Trusted remote automation can manage notices without impersonating a tenant:

```ts
import { OpenshipOperatorClient } from "openship/client";
const operator = new OpenshipOperatorClient({
  baseUrl: "https://ship.example.com",
  internalToken: process.env.OPENSHIP_INTERNAL_TOKEN!,
});
await operator.notices.create({ title: "Maintenance", message: "Scheduled maintenance at 02:00 UTC" });
```

Operator credentials are distinct from PATs and cannot be combined with a tenant scope. The client confines requests to the configured API and refuses redirects. Notice dates accept ISO dates or timestamps with an explicit timezone; removal deactivates the notice and retains history.

## Verification

```sh
bun run --cwd packages/platform test
bun run --cwd packages/sdk test
bun run --cwd apps/api test test/modules/deployments/native-sdk-parity.test.ts
bun run --cwd apps/cli test
bun run --cwd packages/openship build
bun run --cwd packages/openship test:package
```

The owned-native tests use real Node workers, PGlite, and the retained deployment pipeline. The packed-artifact check installs outside the workspace and tests ESM/CommonJS, NodeNext declarations, passive imports, native generated deployment and persistence, remote submission, and CLI loading. Set `OPENSHIP_TEST_NODE` to another Node executable to run the same checks there. Live Docker/cloud/SSH scenarios remain distinct provider gates.

The [migration audit](../../docs/ship-sdk-migration-audit.md) records the original-to-engine file mapping, reviewed behavior changes, compatibility checks, and remaining limits.
