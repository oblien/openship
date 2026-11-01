# Platform architecture

`@repo/adapters` connects the deployment engine to its execution destination.
The platform composes runtime, executor, routing, certificates and optional host
setup; resource services resolve ownership before constructing a platform.

| Layer | Connected/local server | Managed Cloud server |
| --- | --- | --- |
| Applications | `DockerRuntime` or `BareRuntime` | The same Docker or bare engines |
| Transport | Local socket, SSH or host executor | Oblien runtime executor and authenticated Docker bridge |
| Bare supervision | Available host supervisor | `CloudProcessSupervisor` |
| Routing/TLS | `NginxProvider` (or configured host provider) | `CloudInfraProvider` |
| Provisioning | Owner's host and `SystemManager` | Subscription-owned Oblien server |

Desktop local execution uses the bare engine with a no-op edge provider; a
selected connected or managed destination resolves its own platform. Kubernetes
is a separate runtime destination selected through the cluster resolver.

## Responsibilities

`RuntimeAdapter` owns builds, application lifecycle, logs, metrics and retained
artifacts. `CommandExecutor` transports commands and files to the same target.
`RoutingProvider` and `SslProvider` own domains and certificates independently of
application execution. `SystemManager` handles applicable host prerequisites.
Cloud uses provider-managed ingress and never installs the self-hosted edge.

`CloudDockerRuntime` extends the Docker adapter with provider transport, project
storage/listener isolation and source staging. It does not provision application
VMs. `BareRuntime` receives its executor and supervisor through the existing
interfaces. There is no third native Cloud application engine.

The process-wide Cloud platform is unbound and rejects application work.
`resolveDeploymentPlatform` resolves a saved `serverId` and its tenant before
building an application platform. Read callers use
`resolveDeploymentRuntimeForRead` so a status poll does not initialize the host
edge. Release acquired runtime transports in a `finally` block; do not dispose
shared process-owned platform objects.

## Source map

- `platform.ts`: adapter composition and process-owned platform.
- `runtime/{docker,bare}.ts`: shared application engines.
- `runtime/cloud/server-connection.ts`: authenticated provider host transport.
- `runtime/cloud/{docker,process-supervisor,workspace-executor}.ts`: Cloud
  integration with the same engine/executor interfaces.
- `infra/cloud.ts`: project-scoped provider routes and certificates.
- `infra/{nginx,noop}.ts`: host and no-op edge providers.
- `backup/executors/{docker,bare}.ts`: shared backup execution.

See [Cloud execution](CLOUD.md) and [build pipeline](BUILD-PIPELINE.md).
