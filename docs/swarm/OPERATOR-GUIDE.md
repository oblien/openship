# Docker Swarm operator guide

This guide is for the operator who owns both the OpenShip organization and the
Swarm cluster. Swarm support is experimental and is disabled unless
`OPENSHIP_EXPERIMENTAL_SWARM=true` is set on the API. When it is off, the
dashboard has no Swarm tab and OpenShip schedules no Swarm maintenance jobs.

OpenShip can observe a stack safely before it is allowed to manage it. Start in
that read-only state, keep Portainer or your existing CLI workflow as the
writer, and promote one stack only after the source and current manager state
have been reviewed.

## Before connecting a cluster

- Use a reachable **Swarm manager**, not a worker. The Docker socket or SSH
  account needs manager-capable Docker access and is therefore cluster-admin,
  root-equivalent authority. Do not expose the Docker socket to the network or
  give an untrusted tenant access to this OpenShip target.
- Confirm every worker can pull the service images. Source builds need an OCI
  registry reachable by every eligible worker; a locally built image on the
  manager is not enough.
- Record the current writer, stack name, source repository/commit, external
  networks, configs, secrets, volumes, placement constraints, DNS owner, and
  rollback contact. Take the normal manager and application backups before a
  first managed apply.
- Decide whether routing stays externally managed. That is the safe default;
  do not free ports 80/443, change proxy labels, or alter DNS merely to connect
  OpenShip.

## Connect and verify the manager

1. Add or select the OpenShip server connection that reaches the manager.
2. Open its Swarm view and verify cluster identity, manager health, nodes,
   services, and stacks. A worker-only, inactive, or unreachable target is not
   accepted for stack operations.
3. Bind the project to the discovered stack by its exact stack name. The initial
   binding is **observe** mode.
4. If the manager address changes, use the explicit rebind action only after
   OpenShip verifies the replacement is a manager in the same cluster. A failed
   check leaves the existing binding intact; do not change database records or
   bypass it with a worker endpoint.

## Operate alongside Portainer or the Docker CLI

Observe mode is designed for dual-writer environments. It lists live manager
state, task history, service/task logs, and drift without deploying, scaling,
restarting, removing, attaching networks, or editing a task container.

While Portainer or the CLI is still the writer:

- Leave the stack in observe mode.
- Treat a Portainer/CLI change as authoritative and refresh the OpenShip
  preview afterward.
- Never attempt an OpenShip claim while another rollout, image update, or
  service edit is running.

To make OpenShip the writer, first link an authoritative source and render a
fresh preview. The claim action checks the exact stack name, latest manager
digest, source version, ownership/labels, routing, storage, and external
resource requirements. Any Portainer or CLI change between preview and claim
causes a safe stale-state rejection. Refresh, resolve the disagreement with the
other writer, and make a new explicit claim; do not retry a stale request.

After a successful claim, choose **one writer**. Portainer remains useful as a
read-only/fallback console, but do not use it to edit a managed service except
during an incident that has been deliberately handed back to its operator.

## Provide and review desired state

Choose one of these source forms:

- **Repository source**: select the project repository, ref, and
  repository-relative Compose/config/secret paths. OpenShip reads only that
  configured repository under a private staging root; it rejects escapes,
  symlinks, unsupported source paths, and oversized inputs.
- **Inline source**: paste the complete stack YAML. The stored source is
  encrypted; previews, logs, and audit data use a redacted representation.
- **Observed source**: a manager import is useful for observation but Docker
  cannot reconstruct the original Compose source. Link a repository or enter
  reviewed inline source before claiming it.

Use **Render/Preview** before every claim, deployment, or rollback. Review the
redacted rendered document, source/live digest, service images, immutable
config/secret references, storage/routing warnings, and semantic change list.
Never paste registry credentials, manager credentials, or secret values into a
log or support ticket.

## Registry and source-build workflow

Image-only stacks can be observed or managed without an OpenShip registry.
When any service uses `build:`, create an organization registry entry, test it,
and select it on the stack before deployment. Credentials are write-only after
save. OpenShip builds through the Docker runtime, pushes a deterministic image,
resolves its digest, and deploys the digest-pinned image. Manager-side registry
authentication is staged only for the deploy command.

If a worker cannot pull a private image, correct worker access or the registry
credential, test again, and deploy a new reviewed revision. Do not substitute a
mutable tag or expose the credential in task environment/log output.

## Routing, certificates, configs, secrets, and storage

### Routing and Edge cutover

`external` routing preserves existing proxy labels, ports, networks, and DNS;
it is the default for every imported stack. Use it for Portainer/Traefik/Nginx
Proxy Manager ownership or any existing public endpoint.

`openship-edge` is an explicit cutover. Before enabling it, verify the chosen
overlay/network, upstream service port, DNS, certificate owner, and that no
other proxy is expected to bind or manage the same route. Perform the cutover
in a maintenance window with a tested return path to the external proxy. The
Edge uses manager-owned service/config updates; never exec into a task
container to modify proxy configuration.

### Configs and secrets

OpenShip records names and redacted metadata, not secret payloads. Mark an
object external when another controller owns it. Removal is blocked if Docker
would delete a stack-owned config or secret unexpectedly; preserve or convert
the resource deliberately before retrying. External configs, secrets, volumes,
and networks are never deleted by stack removal.

### Storage warning

Named local volumes are node-local. A replacement task on another worker may
start with an empty volume, and OpenShip cannot make a local volume highly
available. Pin the service to the data node and maintain backups, or use a
tested shared-volume driver. Acknowledge each storage warning only after
reviewing the placement and recovery plan. Replacing an attached persistent
volume identity requires a separate explicit acknowledgement.

## Day-two operations

For a **managed** stack, use the stack/service controls to:

- deploy the reviewed source and watch convergence;
- scale a replicated service (including scale-to-zero);
- force a service restart while retaining its durable service identity;
- inspect bounded service/task history and follow redacted logs; and
- remove the exact named stack after the resource preflight succeeds.

Global and job services cannot be treated as replicated scale targets. A
task-specific log stream ends with that task; follow the service stream to see
replacement tasks. Docker log-driver limitations are shown as an actionable
diagnostic rather than guessed around.

Use a stored immutable revision and fresh preview for rollback. Rollback is an
explicit desired-state deployment, not a task-container mutation. Re-review
image, config/secret, routing, and persistent-volume implications before
applying it.

If an apply or removal loses its connection after Docker may have accepted it,
OpenShip marks it `reconciling`. Restore manager access and let it inspect the
live stack. Do **not** repeat the destructive or deploy command blindly. See
[FAILURE-RECOVERY.md](FAILURE-RECOVERY.md) for the exact recovery action for
manager loss, scheduling/placement, image pulls, registry failures, missing
external resources, health failures, paused updates, automatic rollback, API
restart, stale claims, log rescheduling, and manager rebinding.

## Release, disaster recovery, and compatibility

Use the administrative handoff export before releasing a managed stack. It
provides secret-safe source/revision and external-resource notes. **Release
management** returns the stack to observe mode without stopping workloads or
stripping labels; it is the reversible way to return writing authority to
Portainer or the CLI.

For a manager or OpenShip recovery, restore the normal manager/application
backups, reconnect a verified manager in the same cluster, and allow
reconciliation to read current state before choosing a source revision. Do not
restore a database backup and immediately reapply stale desired state over an
unknown live stack.

Existing standalone Docker/Compose, bare-metal, cloud/static, and desktop
deployments retain their original runtime paths. Connecting or enabling Swarm
does not convert them, and normal Compose services continue to use Docker's
per-container lifecycle. Keep the feature gate off on installations that do
not need Swarm; no additional required configuration is introduced.

For a disposable manager/worker rehearsal, use the namespaced commands in
[TEST-MATRIX.md](TEST-MATRIX.md). They are laboratory-only and must never be
pointed at a production manager.
