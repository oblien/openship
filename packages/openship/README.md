# Openship SDK and CLI

The `openship` distribution contains Ship SDK and the CLI. Version 0.8.0 and later includes native and remote SDK entries, TypeScript declarations, and ESM/CommonJS support on Node.js 22+.

Install the package in your Node project:

```sh
npm install openship
```

Upgrade an older CLI-only dependency with `npm install openship@latest`. The [Ship SDK guide](https://openship.io/docs/api/sdk) covers remote connections, native embedding, deployment workflows, scaling, and the shared SDK/REST reference. Contributors can build with `bun run build:sdk`, run `npm pack` in this directory, and install the printed tarball to test unpublished changes.

Use a remote client with a cloud or self-hosted Openship installation:

```ts
import { OpenshipClient } from "openship/client";

const ship = new OpenshipClient({
  baseUrl: "https://ship.example.com",
  token: process.env.OPENSHIP_TOKEN,
  organizationId: "your-organization-id",
});
const submitted = await ship.deploy({
  name: "generated-app",
  source: { type: "files", files: { "index.html": "<h1>Hello from Openship</h1>" } },
});
console.log(await ship.deployment(submitted.deployment_id).wait());
```

The root and `openship/native` export `createShip`. Its asynchronous factory owns storage, providers, and a Node worker inside the host process; it invokes the shared platform operations without starting an HTTP server. Configure `instanceId`, an absolute `stateDirectory`, explicit PGlite/PostgreSQL storage, a persistent `encryptionKey`, `runtime`, and a trusted `identity.resolve` adapter. Call `start()`, obtain a user/organization view with `scope()`, and call `close()` during application shutdown.

Native host execution requires explicit policy. Directory inputs require allowed source roots. Optional trusted host administration maps external users and namespaces; ordinary scoped clients receive no operator access. The trusted identity adapter verifies each assertion, and the platform rereads membership/grants on each call. The host adapter must observe revocation.

Try the included [native lifecycle example](examples/native-lifecycle.mjs) from a Node project with `openship` installed:

```sh
node node_modules/openship/examples/native-lifecycle.mjs
```

You can also copy the file into your project and run it there. It imports `createShip` from `openship`, creates two user scopes, deploys generated HTML, updates configuration and redeploys, checks isolation and session revocation, reopens saved state, and deletes the project. Assertions make failed operations exit with an error. It creates and removes its own temporary installation; it needs no API credentials, Docker daemon, or external database.

The example uses the real bare runtime with `routing: "none"`: it produces static releases without a public URL. It does not check Cloud, SSH, Docker, or public routing. Its temporary encryption key and in-memory session map are for the demo; a persistent application must retain its key and verify sessions through its authentication service. The external package checks execute this same file on Node 22 and 24, along with ESM/CommonJS, declarations, and installed CLI checks.

Native and remote modes share operations for projects/sources/deployments, services, domains/DNS, credentials, server management, catalog apps, backups/jobs, analytics/issues/notifications, settings/audit/updates, incoming webhooks, tokens, permissions/invitations, GitHub, and billing. Public announcements use `notices.list()`. Trusted native hosts can enable `operator.notices`; remote operators use `OpenshipOperatorClient` with an explicit internal token.

`deploy()` returns IDs; `deployment(id)` creates a handle. Native CLI mode exists and its legacy transport/deployment helpers are removed. The full migration is still in progress: mail, data transfer, verified cloud tenant mapping, remaining system/account/channel operations, durable dispatch, billing replay/accounting review and scheduler ownership remain open. The repository's SDK README, `docs/ship-sdk-plan.md`, and `docs/ship-sdk-migration-audit.md` record current coverage and checks.

`organizationId` creates a fixed tenant view and requires a server advertising fixed SDK scope support. Connect directly to the canonical cloud instance when using its tenant scope; fixed forwarding through legacy owner-account links remains unavailable until verified tenant mapping is implemented.

Mutations are submitted once. A network failure never automatically replays a deployment. Cancelling a wait stops the caller's wait; cancel execution with `ship.deployments.cancel(id)`.

ESM and CommonJS are supported on Node 22+. Imports do not start the CLI, an HTTP listener, or a database. SDK source packaging works without a system `tar` executable.

```sh
npx openship --help
```
