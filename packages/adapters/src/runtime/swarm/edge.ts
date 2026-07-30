/**
 * Deliberate, cluster-scoped topology for an opt-in OpenShip Swarm Edge.
 *
 * This is intentionally not the host-network `openship-edge` container used by
 * standalone Docker projects. A Swarm task can be rescheduled to another node,
 * so its state is attached to a labelled ingress node and changes are performed
 * through Swarm service updates rather than `docker exec` against a task ID.
 */

import { buildEdgeImageRef } from "@repo/core";
import type { CommandExecutor } from "../../types";
import { sq } from "../git-clone";
import type { StackRuntimeAdapter, SwarmDiscoverySnapshot } from "./types";

export const SWARM_EDGE_SERVICE_NAME = "openship-edge";
export const SWARM_EDGE_NETWORK_NAME = "openship-edge";
export const SWARM_EDGE_INGRESS_LABEL = "openship.edge.ingress";
export const SWARM_EDGE_LABEL = "com.openship.edge";
export const SWARM_EDGE_NETWORK_LABEL = "com.openship.edge.network";

const SWARM_EDGE_VOLUMES = [
  ["openship-edge-sites", "/usr/local/openresty/nginx/conf/sites-enabled"],
  ["openship-edge-certs", "/etc/letsencrypt"],
  ["openship-edge-acme", "/var/www/acme"],
] as const;

export interface SwarmEdgeStatus {
  serviceId: string;
  image: string;
  networkName: string;
  ingressLabel: string;
  taskIds: string[];
  nodeIds: string[];
}

export class SwarmEdgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmEdgeError";
  }
}

export interface EnsureSwarmEdgeInput {
  /** Edge image is release-pinned by the API; this override is test/operator scoped. */
  image?: string;
  /** A node must carry this label with value `true`; the default is intentionally explicit. */
  ingressLabel?: string;
}

type EdgeExecutor = Pick<CommandExecutor, "exec">;
type EdgeRuntime = Pick<StackRuntimeAdapter, "probe" | "discover">;

function assertImage(value: string): string {
  const image = value.trim();
  if (!image || image.length > 512 || /[\s\u0000-\u001f'"`;|&$<>\\]/.test(image)) {
    throw new SwarmEdgeError("The OpenShip Edge image reference is invalid.");
  }
  return image;
}

function assertLabel(value: string): string {
  const label = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(label)) {
    throw new SwarmEdgeError("The OpenShip Edge ingress node label is invalid.");
  }
  return label;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function labels(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function portPresent(value: unknown, published: number): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((port) => {
    const record = asRecord(port);
    return record?.PublishedPort === published && record.TargetPort === published && record.PublishMode === "host";
  });
}

/** The exact service argv is exported for command-level and operator-doc tests. */
export function buildSwarmEdgeCreateCommand(input: { image: string; ingressLabel: string }): string {
  const image = assertImage(input.image);
  const ingressLabel = assertLabel(input.ingressLabel);
  return [
    "docker service create",
    `--name ${sq(SWARM_EDGE_SERVICE_NAME)}`,
    "--replicas 1",
    `--constraint ${sq(`node.labels.${ingressLabel} == true`)}`,
    "--restart-condition any",
    "--update-order stop-first",
    "--update-parallelism 1",
    "--publish published=80,target=80,protocol=tcp,mode=host",
    "--publish published=443,target=443,protocol=tcp,mode=host",
    `--network ${sq(SWARM_EDGE_NETWORK_NAME)}`,
    `--label ${sq(`${SWARM_EDGE_LABEL}=swarm`)}`,
    `--label ${sq("com.openship.managed=true")}`,
    `--label ${sq("com.openship.edge.topology=single-ingress")}`,
    ...SWARM_EDGE_VOLUMES.map(([source, target]) => `--mount ${sq(`type=volume,source=${source},target=${target}`)}`),
    sq(image),
  ].join(" ");
}

function isEligibleIngress(snapshot: SwarmDiscoverySnapshot, ingressLabel: string): boolean {
  return snapshot.nodes.some((node) =>
    node.status.toLowerCase() === "ready" &&
    node.availability.toLowerCase() === "active" &&
    node.labels[ingressLabel] === "true",
  );
}

function assertEdgePortsAreAvailable(snapshot: SwarmDiscoverySnapshot): void {
  const owner = snapshot.services.find((service) =>
    service.name !== SWARM_EDGE_SERVICE_NAME &&
    service.publishedPorts.some((port) => port.mode === "host" && (port.published === 80 || port.published === 443)),
  );
  if (owner) {
    throw new SwarmEdgeError(
      `Swarm service ${owner.name} already owns a public edge port. OpenShip Edge will not take over a Swarm router; use the explicit cutover workflow.`,
    );
  }
}

function readJson(value: string, resource: string): Record<string, unknown> | null {
  const text = value.trim();
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw new SwarmEdgeError(`Docker returned an unreadable OpenShip Edge ${resource}.`);
  }
}

/**
 * Controls only the cluster singleton. Project stacks never own this network or
 * service, which makes a later HA rollout independent of application stacks.
 */
export class SwarmEdgeManager {
  constructor(
    private readonly runtime: EdgeRuntime,
    private readonly executor: EdgeExecutor,
  ) {}

  private async inspect(command: string, resource: string): Promise<Record<string, unknown> | null> {
    const raw = await this.executor.exec(`${command} 2>/dev/null || true`);
    return readJson(raw, resource);
  }

  private async ensureNetwork(): Promise<void> {
    const network = await this.inspect(
      `docker network inspect ${sq(SWARM_EDGE_NETWORK_NAME)} --format '{{json .}}'`,
      "network",
    );
    if (!network) {
      await this.executor.exec([
        "docker network create --driver overlay",
        "--attachable=false",
        `--label ${sq(`${SWARM_EDGE_NETWORK_LABEL}=true`)}`,
        `--label ${sq("com.openship.managed=true")}`,
        sq(SWARM_EDGE_NETWORK_NAME),
      ].join(" "));
      return;
    }
    if (
      network.Name !== SWARM_EDGE_NETWORK_NAME ||
      network.Driver !== "overlay" ||
      network.Scope !== "swarm" ||
      labels(network.Labels)[SWARM_EDGE_NETWORK_LABEL] !== "true"
    ) {
      throw new SwarmEdgeError(
        `The existing ${SWARM_EDGE_NETWORK_NAME} network is not an OpenShip-managed Swarm overlay. Rename or remove it before enabling OpenShip Edge.`,
      );
    }
  }

  private assertService(service: Record<string, unknown>, ingressLabel: string): void {
    const spec = asRecord(service.Spec);
    if (!spec || labels(spec.Labels)[SWARM_EDGE_LABEL] !== "swarm") {
      throw new SwarmEdgeError(
        `The existing ${SWARM_EDGE_SERVICE_NAME} service is not managed by OpenShip. OpenShip will not replace a router service automatically.`,
      );
    }
    const taskTemplate = asRecord(spec.TaskTemplate);
    const placement = asRecord(taskTemplate?.Placement);
    const constraints = Array.isArray(placement?.Constraints) ? placement.Constraints : [];
    if (!constraints.includes(`node.labels.${ingressLabel} == true`)) {
      throw new SwarmEdgeError("The existing OpenShip Edge service uses a different ingress-node constraint.");
    }
    const endpoint = asRecord(spec.EndpointSpec);
    if (!portPresent(endpoint?.Ports, 80) || !portPresent(endpoint?.Ports, 443)) {
      throw new SwarmEdgeError("The existing OpenShip Edge service does not own host ports 80 and 443.");
    }
  }

  private statusFromSnapshot(snapshot: SwarmDiscoverySnapshot, image: string, ingressLabel: string): SwarmEdgeStatus {
    const service = snapshot.services.find((candidate) => candidate.name === SWARM_EDGE_SERVICE_NAME);
    if (!service) throw new SwarmEdgeError("OpenShip Edge was accepted by the manager but is not yet discoverable.");
    const tasks = snapshot.tasks.filter((task) => task.serviceId === service.id);
    return {
      serviceId: service.id,
      image: service.image ?? image,
      networkName: SWARM_EDGE_NETWORK_NAME,
      ingressLabel,
      taskIds: tasks.map((task) => task.id).sort(),
      nodeIds: tasks.flatMap((task) => task.nodeId ? [task.nodeId] : []).sort(),
    };
  }

  async ensure(input: EnsureSwarmEdgeInput = {}): Promise<SwarmEdgeStatus> {
    const image = assertImage(input.image ?? buildEdgeImageRef());
    const ingressLabel = assertLabel(input.ingressLabel ?? SWARM_EDGE_INGRESS_LABEL);
    await this.runtime.probe();
    const before = await this.runtime.discover();
    if (!isEligibleIngress(before, ingressLabel)) {
      throw new SwarmEdgeError(
        `No ready active Swarm node has ${ingressLabel}=true. Label one deliberate ingress node before enabling OpenShip Edge.`,
      );
    }
    assertEdgePortsAreAvailable(before);
    await this.ensureNetwork();
    const existing = await this.inspect(
      `docker service inspect ${sq(SWARM_EDGE_SERVICE_NAME)} --format '{{json .}}'`,
      "service",
    );
    if (existing) {
      this.assertService(existing, ingressLabel);
      return this.statusFromSnapshot(before, image, ingressLabel);
    }
    const created = await this.executor.exec(buildSwarmEdgeCreateCommand({ image, ingressLabel }));
    const after = await this.runtime.discover();
    const discovered = after.services.some((service) => service.name === SWARM_EDGE_SERVICE_NAME);
    if (discovered) return this.statusFromSnapshot(after, image, ingressLabel);
    // `docker service create` has committed before the scheduler creates a task.
    // Return its opaque ID now; status() always re-discovers later manager truth.
    const serviceId = created.trim().split(/\s+/).at(-1) ?? "";
    if (!/^[A-Za-z0-9]{8,128}$/.test(serviceId)) {
      throw new SwarmEdgeError("Docker accepted OpenShip Edge creation but did not return a service identity.");
    }
    return { serviceId, image, networkName: SWARM_EDGE_NETWORK_NAME, ingressLabel, taskIds: [], nodeIds: [] };
  }

  /** Finds the current task from manager truth after any reschedule. */
  async status(input: Pick<EnsureSwarmEdgeInput, "image" | "ingressLabel"> = {}): Promise<SwarmEdgeStatus | null> {
    const image = assertImage(input.image ?? buildEdgeImageRef());
    const ingressLabel = assertLabel(input.ingressLabel ?? SWARM_EDGE_INGRESS_LABEL);
    await this.runtime.probe();
    const snapshot = await this.runtime.discover();
    const service = snapshot.services.find((candidate) => candidate.name === SWARM_EDGE_SERVICE_NAME);
    return service ? this.statusFromSnapshot(snapshot, image, ingressLabel) : null;
  }
}
