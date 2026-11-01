# CLI and SDK platform coverage — 2026-10-07

The CLI can operate an existing Openship Cloud or remote self-hosted controller from a machine with
Node.js 22 and API access. Remote commands do not require a local Openship installation, database,
Docker daemon, or SSH connection to the controller. They authenticate with that controller's PAT and
use its current membership, resource grants, product capabilities and provider configuration.

This audit started from `origin/main` at `93cdaebd`. Work is isolated on
`feat/cli-sdk-platform-coverage`; the concurrent instance handoff work in #1079 was not copied or reset.

## What was missing and what changed

- Named CLI operations now cover Cloud billing and managed servers, repository management,
  preferences, analytics, private networks and compute clusters, project databases and volumes,
  source/routing administration, installation recovery and remaining resource controls.
- The remote SDK adds 58 mail methods, 23 workload migration methods, 11 instance operations and
  two interactive terminal methods. These adapt existing HTTP controllers. They do not create a
  second provider, database, permission system, certificate workflow or migration engine.
- Mail and edge CLI administration now use the SDK. Instance archive and legacy migration commands
  also use named SDK methods. Public liveness probes and the deliberately generic `api` command
  remain HTTP-oriented.
- A selected context pins API, token, organization and capabilities for the invocation. CI
  environment credentials are ephemeral. Explicit contexts ignore ambient connection overrides;
  retargeting an API does not reuse the previous API's credentials or organization.
- Login accepts private token files/stdin and masks interactive input. Logout accurately reports a
  still-active environment token. SSH registration accepts a private key from the caller's machine;
  controller-host key paths retain their separate meaning.
- First run offers connecting to Cloud or a remote controller alongside local installation. The
  installer keeps its existing setup/control menu. The installation owner can use resource commands
  without a PAT: the CLI exchanges the protected bare/Compose internal credential over loopback for
  a temporary normal session. `--local` explicitly selects that installation without altering saved
  contexts. This does not enable zero-auth HTTP access or replace an explicit limited credential.
- Project deletion refuses unattended prompts without confirmation. Server updates, installs,
  migration completion, shell execution and setup streams preserve failed outcomes. Reattachment
  observes the existing operation. Quotes, revisions, sequences, selected container IDs and cutover
  tokens are passed unchanged; an uncertain mutation is not automatically replayed.
- Complex new configuration commands accept JSON files/stdin and expose their shared input schemas.
  Instance exports create private files without overwriting another file. CLI/docs no longer claim
  that current plaintext exports are encrypted by a passphrase.

## Inventory and how to reproduce it

`scripts/docs-surface.mjs` now inspects both `ScopedShip` and `OpenshipClient`. The API reference
contains **563 named resource methods** and **704 distinct HTTP method/path pairs**. Root SDK
workflows such as `deploy`, `deployment().wait` and `scope` are documented separately.

The built public CLI exposes **670 command paths**, including command groups. This is an inventory,
not a test coverage percentage or a claim that every provider has been exercised live. Generated
references contain each HTTP route once and label remote-only methods explicitly.

```sh
bun run --cwd packages/openship build
node scripts/generate-api-reference.mjs --write
node scripts/generate-cli-reference.mjs --write
node scripts/check-docs.mjs
bun test scripts/docs-sdk.test.mjs scripts/docs-http.test.mjs scripts/docs-mcp.test.mjs
```

The existing documentation catalog remains the route/method inventory; there is no second manually
maintained endpoint registry. The documentation regression prevents remote-only methods from silently
disappearing when native and remote surfaces differ.

## Workflow coverage

| Platform area                       | Canonical CLI surface                                                       | SDK surface and constraints                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Connections and CI                  | `login`, `logout`, `context`, global connection/organization options        | `OpenshipClient`, fixed organization protocol and rotating token callback                                                       |
| Source, projects and deployment     | `init`, `deploy`, `deployment`, `project`, `logs`                           | `projects`, `sources`, `deployments`, `deploy`, deployment handles; local-folder uploads use shared staging                     |
| Service configuration and execution | `service`, `server exec`                                                    | `services`, `servers.exec`; quoted commands and remote exit status                                                              |
| Catalog applications                | `app`, project connections/storage                                          | `apps`, `projects`; catalog-driven inputs and shared installation/configuration                                                 |
| Domains, routing and certificates   | `domain`, `dns`, project routing, `edge`                                    | `domains`, `dns`, `projects`; existing ownership and certificate operations                                                     |
| Cloud plans and capacity            | `billing`, `server managed`                                                 | `billing`, `servers`; exact subscription workspace, quote/revision/idempotency checks                                           |
| SSH and infrastructure              | `server`, `server network`, `server cluster`                                | `servers`; connection, installer, container, tunnel, runtime and shared-storage operations                                      |
| Scaled workloads and managed data   | `project cluster`, `project database`, `project volume`                     | Project control methods; reviewed deployment IDs, sequences, resource versions and retention choices                            |
| Backups and scheduled work          | `backup`, `job`                                                             | `backups`, `backupDestinations`, `jobs`; existing policies, executions, restore sessions and scheduling                         |
| Monitoring and operations           | `monitoring`, `analytics`, `notification`, `webhook`, `audit`               | `issues`, `updates`, `analytics`, `notifications`, `webhooks`, `audit`                                                          |
| GitHub and clone identity           | `github`, `server github`, project Git/clone commands                       | `github`, `servers`, `projects`; repository and deployment-server identities remain distinct                                    |
| Permissions and credentials         | `access`, `token`, `credential`                                             | `permissions`, `tokens`, `credentials`; no escalation from scoped or read-only credentials                                      |
| User/instance settings              | `settings`, `system`                                                        | `settings`, `system`, `notices`; instance mutations retain instance authority                                                   |
| Mail                                | `mail`                                                                      | Remote `mail`; self-hosted server ownership, edge renewal, DNS, mailbox/alias/relay/inbound/backup/component/webmail operations |
| Workload move/copy/adoption         | `migration`                                                                 | Remote `migrations`; discovery, preview, exact selection, durable status, decisions, cutover and partial recovery               |
| Interactive terminals               | `server ssh`, `server terminal`, `service terminal`                         | Remote `terminal`; single-use ticket, WebSocket bytes/resize, trusted Origin, explicit close and exit outcome                   |
| Instance portability                | `system data-transfer`, `system onboarding`, `system migration`             | Remote `instance`; bootstrap and instance-admin restrictions, opaque archives and explicit import mode                          |
| Host installation/recovery          | `up`, `install`, `update`, `stop`, `doctor`, `uninstall`, password recovery | Existing local operator workflow; these commands intentionally manage the machine running the CLI                               |

The seven legacy `servers.*Cluster` network aliases are covered by the canonical `server network`
commands. They do not need duplicate CLI verbs. `deployments.prepare`, `deployments.buildAccess`,
`sources.stage` and `projects.getServerLogStreamToken` are consumed by the deployment/upload/log
workflows. The CLI should not ask operators to manually reproduce those protocols.

## Cloud and native distinctions

For Cloud-stored records, connect directly to `https://api.openship.io` with a Cloud credential and
its Cloud organization. A local owner's account link is not authorization for a scoped local token
to access Cloud records. That guard remains intact.

Desktop/self-hosted projects can execute on an authorized linked managed server, using that
controller's local server ID. The record and authorization boundary stays local. This is different
from promoting the project's records to another controller.

The 25 shared resource groups retain native SDK support. `mail`, `migrations`, `instance` and
`terminal` are remote groups. Native CLI mode explicitly owns its worker, storage and identity;
remote-only commands never fall back to another saved connection. Host execution and scheduling
remain governed by native policy and the existing provider support.

## Deliberate boundaries and existing platform limits

- Browser sign-in, 2FA enrollment/recovery, private support conversations and payment approval retain
  their session/browser requirements. A PAT is not a substitute for those credentials. Membership,
  grants and token administration already have CLI/SDK operations.
- OAuth callbacks, signed provider webhooks, Cloud relay internals, bootstrap internal tokens,
  direct-transfer pairing/chunk upload and WebSocket handshakes remain transport protocols. The
  CLI/SDK expose their applicable workflows rather than treating every protocol endpoint as a verb.
- The baseline controller's legacy migration to an own server advertises unavailable deployment
  and can return `SERVER_MIGRATION_UNAVAILABLE`. The new `instance` facade preserves that failure;
  it does not claim a successful handoff. The separate control-plane handoff implementation is #1079.
  Workload `migrations` is a different workflow and is covered here.
- Durable multi-worker replay, constrained identities for all background jobs, distributed scheduler
  ownership and billing accounting/replay work remain engine limitations from the earlier SDK
  migration audit. Adding a command does not complete those backend projects.

## Verification

- **Initial audit: 19,160 workspace tests passed, 7 skipped** across all 10 test workspaces with
  `bun run test --output-logs=errors-only -- --maxWorkers 3`. This includes **686 CLI** and
  **232 SDK** tests, actual CLI subprocesses, native workers, PGlite persistence,
  generated-code deployment, redeployment, tenant isolation, revoked access, teardown and cleanup.
- **Local administration follow-up: 712 CLI and 8,348 API tests passed** in the complete suites.
  Real HTTP, Better Auth and PGlite tests verify the installation-owner exchange, ordinary session
  authorization, workspace isolation, sign-out and expired-session cleanup. CLI subprocess tests
  cover bare/Compose credentials, remote isolation, redirect refusal and offline recovery. Login
  is deferred until an API operation needs it; utilities and confirmation checks stay offline.
- **92 repository script tests passed**. Documentation checks compile 209 pages, validate 301 CLI
  examples and type-check 126 SDK examples against the built public package.
- The first full run at default parallelism hit one 10-second monitoring setup timeout. The unchanged
  test passed both alone and in the full run with three workers, with its existing timeout. The
  isolated checkout also needed Electron's existing postinstall to supply its runtime; all 54 desktop
  tests then passed. The final root run reused these successful workspace results from Turbo's cache.
- Targeted API regressions cover terminal tickets/ownership/disconnects, Cloud terminal routing,
  instance-admin restrictions, mail certificate/status handlers and migration scope/reattachment.
- A negative-control check removed endpoint/credential separation temporarily: the actual CLI
  connection regression failed. Restoring the exact implementation made it pass. The temporary
  change was never committed, built into a release, or applied to a live controller.
- TypeScript checks pass for CLI, SDK, contracts, API and dashboard. The frozen Bun install uses the
  existing pinned Bun 1.3.14; the lockfile refresh does not change the project's Bun release.
- The actual npm tarball installs outside the repository on Node 22.21.1 and passes ESM/CommonJS,
  strict NodeNext declarations, passive imports, native lifecycle and npm CLI resolution. It also
  exercises packaged SDK mail/migration/instance requests, fixed tenant headers, both terminal kinds
  over real loopback HTTP/WebSockets, and packaged CLI context selection with conflicting environment
  credentials.
- Public `/api/health` probes on live Openship Cloud and the local dev API both returned HTTP 200
  with `{ protocol: 1, fixedOrganizationScope: true }`.

Remote workflow fixtures verify transport, authorization headers, request choices and outcomes. They
do not prove live provider deployment, real paid checkout, SSH host provisioning, live DNS/ACME renewal,
mail delivery or moving production workloads. No such live mutation was performed for this audit.

The executable verification entry points are the workspace tests, `packages/openship/verify-package.ts`,
and `scripts/check-docs.mjs`. Keep provider release checks separate from these automated results.
