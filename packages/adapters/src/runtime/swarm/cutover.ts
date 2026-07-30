/** Reversible, service-level handoff of 80/443 from one Swarm router to Edge. */

import { createHash } from "node:crypto";
import { buildEdgeImageRef } from "@repo/core";
import type { CommandExecutor } from "../../types";
import { sq } from "../git-clone";
import {
  SWARM_EDGE_LABEL,
  SWARM_EDGE_INGRESS_LABEL,
  SWARM_EDGE_NETWORK_NAME,
  SWARM_EDGE_SERVICE_NAME,
  SwarmEdgeManager,
} from "./edge";
import type { StackRuntimeAdapter, SwarmPublishedPort, SwarmServiceState } from "./types";

const JOURNAL_LABEL = "com.openship.edge.cutover";
const JOURNAL_STAGE_PREFIX = "/tmp/openship-swarm-edge-cutover.";
const EDGE_PORTS = new Set([80, 443]);
const EDGE_ROUTE_LABEL = "com.openship.edge.route";
const EDGE_ROUTE_DOMAIN_LABEL = "com.openship.edge.domain";
const HEALTH_SERVICE_PREFIX = "openship-edge-cutover-health-";

type CutoverExecutor = Pick<CommandExecutor, "exec" | "writeFile" | "rm">;
type CutoverRuntime = Pick<StackRuntimeAdapter, "probe" | "discover">;

export type SwarmEdgeCutoverPlan =
  | { kind: "none"; message: string }
  | { kind: "openship-edge"; message: string; edgeServiceId: string }
  | { kind: "multiple-services"; message: string; services: string[] }
  | { kind: "unsupported"; message: string; serviceId: string; serviceName: string; mode: string }
  | {
      kind: "swarm-service";
      serviceId: string;
      serviceName: string;
      stackName: string | null;
      specVersion: number;
      replicas: number;
      ports: SwarmPublishedPort[];
      strategy: "scale-and-remove-published-ports";
      message: string;
    };

interface CutoverJournal {
  version: 1;
  serviceId: string;
  serviceName: string;
  replicas: number;
  ports: Array<{ target: number; published: number; protocol: "tcp" | "udp" | "sctp"; mode: "ingress" | "host" }>;
}

export class SwarmEdgeCutoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmEdgeCutoverError";
  }
}

function edgePorts(service: SwarmServiceState): SwarmPublishedPort[] {
  return service.publishedPorts.filter((port) => port.published !== null && EDGE_PORTS.has(port.published));
}

function validatePort(port: SwarmPublishedPort): CutoverJournal["ports"][number] {
  if (
    !Number.isInteger(port.target) || port.target < 1 || port.target > 65_535 ||
    !Number.isInteger(port.published) || !port.published || !EDGE_PORTS.has(port.published) ||
    !["tcp", "udp", "sctp"].includes(port.protocol) ||
    !["ingress", "host"].includes(port.mode)
  ) {
    throw new SwarmEdgeCutoverError("The router has an unsupported published edge-port specification.");
  }
  return {
    target: port.target,
    published: port.published,
    protocol: port.protocol as "tcp" | "udp" | "sctp",
    mode: port.mode as "ingress" | "host",
  };
}

function publishSpec(port: CutoverJournal["ports"][number]): string {
  return `target=${port.target},published=${port.published},protocol=${port.protocol},mode=${port.mode}`;
}

function journalName(serviceId: string): string {
  return `openship-edge-cutover-${createHash("sha256").update(serviceId).digest("hex").slice(0, 20)}`;
}

/** Config labels are metadata-only, unlike config payloads, and name served domains. */
function servedRouteDomains(snapshot: Awaited<ReturnType<CutoverRuntime["discover"]>>): string[] {
  return [...new Set(snapshot.configs.flatMap((config) => {
    const domain = config.labels[EDGE_ROUTE_DOMAIN_LABEL]?.trim().toLowerCase();
    return config.labels[EDGE_ROUTE_LABEL] === "true" && domain &&
      /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) && !domain.includes("..")
      ? [domain]
      : [];
  }))].sort();
}

function planForServices(services: SwarmServiceState[]): SwarmEdgeCutoverPlan {
  const edge = services.find((service) => service.name === SWARM_EDGE_SERVICE_NAME);
  if (edge?.labels[SWARM_EDGE_LABEL] === "swarm") {
    return { kind: "openship-edge", edgeServiceId: edge.id, message: "OpenShip Edge already owns the cluster edge." };
  }
  const owners = services.filter((service) => service.name !== SWARM_EDGE_SERVICE_NAME && edgePorts(service).length > 0);
  if (owners.length === 0) return { kind: "none", message: "No Swarm service currently publishes ports 80 or 443." };
  if (owners.length > 1) {
    return {
      kind: "multiple-services",
      services: owners.map((service) => service.name).sort(),
      message: "More than one Swarm service owns edge ports; OpenShip will not guess a cutover order.",
    };
  }
  const service = owners[0]!;
  if (service.mode !== "replicated" || service.desiredReplicas === null || service.specVersion === null) {
    return {
      kind: "unsupported",
      serviceId: service.id,
      serviceName: service.name,
      mode: service.mode,
      message: "Only a replicated Swarm router can use the reversible initial cutover strategy.",
    };
  }
  return {
    kind: "swarm-service",
    serviceId: service.id,
    serviceName: service.name,
    stackName: service.stackName,
    specVersion: service.specVersion,
    replicas: service.desiredReplicas,
    ports: edgePorts(service).map(validatePort),
    strategy: "scale-and-remove-published-ports",
    message: "The router will be scaled to zero and only its 80/443 publications will be removed. Its replica and port settings are journaled for rollback.",
  };
}

function parseJournal(value: unknown): CutoverJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SwarmEdgeCutoverError("The pending Edge cutover journal is unreadable.");
  const record = value as Record<string, unknown>;
  const replicas = record.replicas;
  if (
    record.version !== 1 || typeof record.serviceId !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(record.serviceId) ||
    typeof record.serviceName !== "string" || !record.serviceName || typeof replicas !== "number" || !Number.isInteger(replicas) ||
    replicas < 0 || replicas > 10_000 || !Array.isArray(record.ports)
  ) throw new SwarmEdgeCutoverError("The pending Edge cutover journal has an invalid shape.");
  return {
    version: 1,
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    replicas,
    ports: record.ports.map((port) => validatePort(port as SwarmPublishedPort)),
  };
}

/**
 * This manager only manipulates a Swarm service spec. It never targets a task
 * container, and its durable config journal makes a disconnected cutover
 * recoverable by a later explicit recovery call.
 */
export class SwarmEdgeCutoverManager {
  constructor(
    private readonly runtime: CutoverRuntime,
    private readonly executor: CutoverExecutor,
  ) {}

  async plan(): Promise<SwarmEdgeCutoverPlan> {
    await this.runtime.probe();
    return planForServices((await this.runtime.discover()).services);
  }

  private async createJournal(journal: CutoverJournal): Promise<string> {
    const name = journalName(journal.serviceId);
    const existing = (await this.executor.exec(`docker config ls --filter ${sq(`label=${JOURNAL_LABEL}=true`)} --format '{{.Name}}'`))
      .split("\n").map((value) => value.trim()).filter(Boolean);
    if (existing.length > 0) {
      throw new SwarmEdgeCutoverError("A previous OpenShip Edge cutover is still pending recovery. Recover it before starting another cutover.");
    }
    let stage: string | null = null;
    try {
      stage = (await this.executor.exec(`umask 077 && mktemp -d ${JOURNAL_STAGE_PREFIX}XXXXXX`)).trim();
      if (!new RegExp(`^${JOURNAL_STAGE_PREFIX.replace(".", "\\.")}[A-Za-z0-9]+$`).test(stage)) {
        throw new SwarmEdgeCutoverError("Docker manager returned an invalid cutover journal staging directory.");
      }
      const path = `${stage}/journal.json`;
      await this.executor.writeFile(path, JSON.stringify(journal));
      await this.executor.exec([
        "docker config create",
        `--label ${sq(`${JOURNAL_LABEL}=true`)}`,
        `--label ${sq(`com.openship.edge.cutover.service-id=${journal.serviceId}`)}`,
        sq(name),
        sq(path),
      ].join(" "));
      return name;
    } finally {
      if (stage) await this.executor.rm(stage).catch(() => {});
    }
  }

  private async clearJournal(name: string): Promise<void> {
    await this.executor.exec(`docker config rm ${sq(name)} >/dev/null 2>&1 || true`);
  }

  private async waitFor(condition: () => Promise<boolean>, description: string): Promise<void> {
    for (let attempt = 0; attempt < 45; attempt++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new SwarmEdgeCutoverError(`Timed out waiting for ${description}.`);
  }

  /**
   * Verifies a live HTTP response across the Edge overlay using a short-lived
   * Swarm task. A route may legitimately return 404 without a Host header, so
   * connection success is the base health condition. Every selected managed
   * route is then checked with its Host header; normal 2xx–4xx application
   * responses are allowed while an unavailable/5xx upstream fails cutover.
   * This never locates or execs a mutable Edge task container.
   */
  private async verifyEdgeHealth(routes: string[]): Promise<void> {
    const suffix = createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16);
    const job = `${HEALTH_SERVICE_PREFIX}${suffix}`;
    const checks = [
      "curl -sS --connect-timeout 5 --max-time 10 -o /dev/null http://openship-edge/",
      ...routes.map((domain) =>
        `code=$(curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' -H ${sq(`Host: ${domain}`)} http://openship-edge/) && test \"$code\" -ge 200 && test \"$code\" -lt 500`,
      ),
    ].join(" && ");
    try {
      await this.executor.exec([
        "docker service create",
        `--name ${sq(job)}`,
        `--constraint ${sq(`node.labels.${SWARM_EDGE_INGRESS_LABEL} == true`)}`,
        "--restart-condition none",
        `--network ${sq(SWARM_EDGE_NETWORK_NAME)}`,
        sq(buildEdgeImageRef()),
        "sh -ec",
        sq(checks),
      ].join(" "));
      await this.executor.exec(`for i in $(seq 1 30); do s=$(docker service ps ${sq(job)} --no-trunc --format '{{.CurrentState}}' | head -1); case \"$s\" in Complete*) exit 0;; *Failed*|*Rejected*) echo \"$s\" >&2; exit 1;; esac; sleep 1; done; exit 1`);
    } finally {
      await this.executor.exec(`docker service rm ${sq(job)} >/dev/null 2>&1 || true`).catch(() => {});
    }
  }

  private async restore(journal: CutoverJournal): Promise<void> {
    const snapshot = await this.runtime.discover();
    const edge = snapshot.services.find((service) => service.name === SWARM_EDGE_SERVICE_NAME);
    if (edge) {
      if (edge.labels[SWARM_EDGE_LABEL] !== "swarm") {
        throw new SwarmEdgeCutoverError("A foreign service now uses the OpenShip Edge name; refusing to remove it during rollback.");
      }
      await this.executor.exec(`docker service rm ${sq(SWARM_EDGE_SERVICE_NAME)}`);
      await this.waitFor(
        async () => !(await this.runtime.discover()).services.some((service) => service.name === SWARM_EDGE_SERVICE_NAME),
        "OpenShip Edge removal before restoring the previous router",
      );
    }
    for (const port of journal.ports) {
      await this.executor.exec(`docker service update --detach=false --publish-add ${sq(publishSpec(port))} ${sq(journal.serviceId)}`);
    }
    await this.executor.exec(`docker service update --detach=false --replicas ${journal.replicas} ${sq(journal.serviceId)}`);
  }

  private async loadPendingJournal(): Promise<{ name: string; journal: CutoverJournal } | null> {
    const names = (await this.executor.exec(`docker config ls --filter ${sq(`label=${JOURNAL_LABEL}=true`)} --format '{{.Name}}'`))
      .split("\n").map((value) => value.trim()).filter(Boolean);
    if (names.length === 0) return null;
    if (names.length > 1) throw new SwarmEdgeCutoverError("More than one OpenShip Edge cutover journal exists; resolve this with operator assistance.");
    const encoded = JSON.parse(await this.executor.exec(`docker config inspect ${sq(names[0]!)} --format '{{json .Spec.Data}}'`));
    if (typeof encoded !== "string") throw new SwarmEdgeCutoverError("The pending Edge cutover journal has no readable data.");
    return { name: names[0]!, journal: parseJournal(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))) };
  }

  async recover(): Promise<{ recovered: boolean; message: string }> {
    const pending = await this.loadPendingJournal();
    if (!pending) return { recovered: false, message: "No pending OpenShip Edge cutover requires recovery." };
    try {
      await this.restore(pending.journal);
      await this.clearJournal(pending.name);
      return { recovered: true, message: `Restored ${pending.journal.serviceName} from its Edge cutover journal.` };
    } catch (error) {
      throw new SwarmEdgeCutoverError(
        `Could not restore the previous router from the Edge cutover journal: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  async execute(input: { serviceId: string; specVersion: number }): Promise<{
    edgeServiceId: string;
    previousServiceName: string;
    healthVerified: true;
    servedRoutes: string[];
  }> {
    const plan = await this.plan();
    if (plan.kind !== "swarm-service") {
      throw new SwarmEdgeCutoverError(plan.message);
    }
    if (plan.serviceId !== input.serviceId || plan.specVersion !== input.specVersion) {
      throw new SwarmEdgeCutoverError("The router changed after the cutover plan was reviewed. Refresh the plan and confirm it again.");
    }
    const journal: CutoverJournal = {
      version: 1,
      serviceId: plan.serviceId,
      serviceName: plan.serviceName,
      replicas: plan.replicas,
      ports: plan.ports.map(validatePort),
    };
    const name = await this.createJournal(journal);
    try {
      await this.executor.exec(`docker service update --detach=false --replicas 0 ${sq(plan.serviceId)}`);
      for (const port of journal.ports) {
        await this.executor.exec(`docker service update --detach=false --publish-rm ${sq(publishSpec(port))} ${sq(plan.serviceId)}`);
      }
      await this.waitFor(async () => {
        const snapshot = await this.runtime.discover();
        const owner = snapshot.services.find((service) => service.id === plan.serviceId);
        return !!owner && owner.desiredReplicas === 0 && edgePorts(owner).length === 0;
      }, "the previous router's replicas and edge publications to stop");
      const edge = new SwarmEdgeManager(this.runtime, this.executor);
      const created = await edge.ensure();
      await this.waitFor(async () => {
        const status = await edge.status();
        return !!status && status.taskIds.length > 0;
      }, "OpenShip Edge to schedule on its ingress node");
      const servedRoutes = servedRouteDomains(await this.runtime.discover());
      await this.verifyEdgeHealth(servedRoutes);
      await this.clearJournal(name);
      return { edgeServiceId: created.serviceId, previousServiceName: plan.serviceName, healthVerified: true, servedRoutes };
    } catch (error) {
      try {
        await this.restore(journal);
        await this.clearJournal(name);
      } catch (rollbackError) {
        throw new SwarmEdgeCutoverError(
          `OpenShip Edge cutover failed and automatic rollback also failed. The persisted cutover journal must be recovered: ${rollbackError instanceof Error ? rollbackError.message : "unknown rollback error"}`,
        );
      }
      throw new SwarmEdgeCutoverError(
        `OpenShip Edge cutover failed; the previous router was restored: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
