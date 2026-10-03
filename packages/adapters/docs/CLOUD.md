# Managed Cloud execution

Cloud applications run on subscription-owned Oblien servers. The application
engines are `DockerRuntime` and `BareRuntime`; Cloud replaces their execution
transport and infrastructure provider, not the deployment pipeline.

## Composition

`createPlatform` binds the requested managed server and project:

- Docker uses `CloudDockerRuntime extends DockerRuntime`. An authenticated
  WebSocket bridge forwards the Docker API to the server's loopback socket.
  Container identity, volumes, image retention, service lifecycle and backups
  keep the shared Docker implementation.
- Bare uses `BareRuntime` with `CloudWorkspaceExecutor` and
  `CloudProcessSupervisor`. Source, retained releases, persistent paths and
  build commands use the same bare engine. Provider workloads supervise only
  the application's process; stopping an app never stops its server.
- `CloudInfraProvider` owns Oblien Pages, domain bindings, complete route tables,
  ingress ports and certificates. It accepts a project routing scope which
  validates listener and static-release ownership.
- An unbound Cloud platform uses `UnboundRuntime`. Infrastructure checks can run
  before checkout, but application execution requires a resolved destination.

Programmatic Oblien transport is primary. Connected servers retain SSH; the
presence of optional SSH on a provider VM does not create another deployment
path or require customers to manage keys.

## Ownership

The API/SDK accepts `serverId`. The platform resolves its organization and
subscription before issuing a namespace-scoped token. A deployment saves the
server and provider binding, including its project and subscription owner.
Read operations validate that binding too. A running runtime is not cached as
a global tenant singleton; callers release each acquired transport.

The Cloud API host never supplies application source through an arbitrary
`localPath`. A completed, owned upload supplies a validated transfer callback,
inline catalog files are constrained to their project directory, and Git is
acquired on the target server. Bare static exports reject escaping paths and
symbolic links into other server data.

## Lifecycle

Host provisioning and billing are outside the runtime adapters. The subscription
worker ensures one durable server and recovers creation by its idempotency key.
Application builds use measured free capacity on that server. They cannot allocate
a second VM or resize the subscription implicitly.

Project cleanup retains the shared server. Resize checkpoints preserve the prior
host state and active Docker/bare applications. Stop/start operations and route
changes share the server mutation lock; Docker bridge setup has a separate lock.

See [managed servers](../../../docs/managed-cloud-servers.md) for ownership,
recovery and verification boundaries. The staging script
`scripts/verify-cloud-docker.ts` exercises provider transport and creates disposable
resources only when invoked with staging credentials. It is not a checkout test.
