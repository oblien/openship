# Git provider boundary

OpenShip supports GitHub and GitLab.com as repository sources. Each uses the same
repository picker, deployment engine and workspace grant policy.

## Connect GitLab

Open **New Project → Repositories → GitLab → Connect GitLab**, or add a GitLab
connection in **Settings → Git → GitLab**. Both use the workspace credential store. Choose **Continue with GitLab** for browser authorization. For a personal token, **Create token on GitLab** opens GitLab with the name and read scopes prefilled.

| Method | Setup |
| --- | --- |
| Browser authorization | A workspace administrator authorizes OpenShip on GitLab.com. OpenShip stores the grant encrypted and refreshes it for repository reads, builds and webhook operations. The grant follows that user's GitLab project permissions. |
| Personal, group or project access token | Use `read_api` and `read_repository` for browsing and private clones. Managing project webhooks requires `api` and permission to manage hooks on the project. A project token can limit access to a single project. |
| GitLab CLI | On desktop or a self-hosted controller, install a current `glab` and run `glab auth login --hostname gitlab.com` as the OS user running the OpenShip API. An instance administrator with workspace admin access can then select **Use GitLab CLI**. This authorizes browsing, webhooks and cloning on the controller for that workspace. Private clones on a remote worker require a workspace OAuth or access token. OpenShip stores the account ID and lets glab supply and refresh its token. Switching the CLI to another account requires linking it again. |

### Enable browser linking

In the OpenShip team's GitLab group, open **Settings → Applications** and register a
confidential OAuth application. Select `api` (includes webhook management) and
`read_repository` (Git over HTTPS). For OpenShip Cloud, register
`https://app.openship.io/connections/callback`. For a self-hosted controller use its
public dashboard origin followed by `/connections/callback`. For local development
register the exact local dashboard callback on a separate development application.

Set `OPENSHIP_CONNECTION_GITLAB_CLIENT_ID` to the Application ID and
`OPENSHIP_CONNECTION_GITLAB_CLIENT_SECRET` to the Secret in the API environment.
Restart the API. Browser linking appears once both are configured. In OpenShip Desktop, authorize in the system browser and select **Return to OpenShip Desktop** to finish in the workspace that started the connection.
[GitLab OAuth applications](https://docs.gitlab.com/integration/oauth_provider/)

In **New Project → Repositories**, select **GitLab**, then choose the namespace and
repository. Nested groups retain their full path. An existing project keeps its own
provider when another provider is selected in the picker. A reachable OpenShip API
or a verified project domain can receive signed GitLab pushes. Private builds that
clone on a remote worker require trusting that worker with the clone credential.

GitLab implements browsing, stack detection, cloning and push deployments. GitHub
App installation, check runs, pull-request previews, source edits and Actions remain
GitHub capabilities. Self-managed GitLab origins are outside this adapter.


## Shared source workflows

`packages/platform/src/engine/modules/git/provider.ts` selects the registered adapter.
A repository is bound to the request context, provider, complete namespace, repository name
and optional organization-scoped server credential. Never cache these bindings or credentials
globally. Unknown provider IDs fail before a credential or transport is selected. Only legacy
records without a provider default to GitHub.

Deployment detection, source reads, clone planning, queued pushes, deployment checks, preview
lifecycle, source changes, migration plans and Actions source access use this boundary.
The shared deployment, routing and migration engines are unchanged in responsibility.
The adapter delegates to the original GitHub files rather than duplicating their protocols.

Optional repository capabilities cover webhooks, checks, pull requests, source changes and
workflow source operations. Callers require the capability before mutation. Actions execution
controllers are separate from source providers: GitHub Actions API operations and signed
GitHub event decoding remain GitHub-specific. Openship workflows can use another source
adapter once it implements the required workflow capabilities.

## Public clients and connections

The `git` operation collection is shared by HTTP (`/api/git/:provider/...`), the SDK/native
client (`ship.git`), CLI (`openship git`) and MCP. Existing `/api/github` clients remain
compatible, including provider-specific connection setup. Dashboard repository browsers,
source settings, migration and workflow setup carry the selected provider. Connection UX
and credential recovery are supplied by the provider adapter using the existing components.

Public provider metadata lives in `packages/core/src/git-providers.ts`: display identity,
namespace grammar, permission resource types and implemented capabilities. The optional
public file endpoint is fixed configuration, used only for bounded, unauthenticated deploy-link
branding reads. Repository URLs cannot supply a credential destination or arbitrary fetch host.

## Persistence and authorization

Webhook/check IDs are opaque strings. The GitHub adapter validates numeric IDs before using
its existing wire API. Preview identity includes provider; cloud binding uniqueness includes
both organization and provider. Actions snapshots and queued deployment intents retain the
provider so identical namespace/repository names cannot match across providers.

Signed push handlers pass a provider, full namespace and repository name to the shared dispatcher.
Project and workflow queries apply that identity and any verified workspace scope in the database.
Cloud forwarding uses the same identity when it looks up a promoted project. Delivery receipts
are keyed by provider and delivery ID, so each provider can retry independently.

The migration preserves legacy GitHub records, encrypted secrets and existing external IDs.
Existing permission resource names remain valid. Providers own their permission families;
repository authority and source content/write capabilities stay separate. GitHub's API-host
CLI token must not be forwarded to build workers, and Enterprise credentials must not reach
the github.com Actions runner.

Adapters that use an OpenShip Cloud session implement `connections.cloudSession` for cache
invalidation and grant cleanup. Disconnecting or expiring that session revokes grants in the
workspaces it served. With the hosted GitHub App, explicit namespace and repository grants
survive for active workspace-owned GitHub App installations. Broad GitHub grants are revoked.
Explicit local GitHub auth modes and independently connected providers such as GitLab keep their grants.

## Adding a provider

1. Register its metadata and backend adapter; normalize its responses in that adapter.
2. Implement only supported optional capabilities. Declare unavailable features explicitly.
3. Register connection transport, hooks/settings UI and verified webhook ingress for its
   authentication protocol. Reuse existing credential storage and authorization infrastructure.
4. Use shared repository and deployment operations. Do not add a second deployment pipeline.
5. Test namespace handling, cross-provider/tenant isolation, missing capabilities, credential
   boundaries and end-to-end deployment. A source adapter does not imply support for that
   provider's separate hosted CI engine or release-artifact API.

## Verifying live repository reads

With a signed-in GitHub CLI or a `GH_TOKEN` with public repository read access, run
`bun run --cwd apps/api test:live-source test/live/git-provider-read.live.test.ts`.
The test starts a loopback API with a disposable database, saves an encrypted test connection,
and reads both the OpenShip GitHub badge demo and GitLab’s Helm chart repository through the SDK in self-hosted and Cloud modes. It also checks out the chart from its nested GitLab namespace using the deployment clone transport.
