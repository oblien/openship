import type { ProjectResources } from "@repo/core";
import type { Service, ServiceInput } from "@/lib/api/services";
import { dependencyProblem } from "./model";

type ChangeBase = { id: string; title: string; saved?: boolean };
export type TopologyChange = ChangeBase &
  (
    | { kind: "create-service"; input: ServiceInput; createdServiceId?: string; started?: boolean }
    | {
        kind: "update-service";
        serviceId: string;
        before: Service;
        patch: Partial<ServiceInput>;
        refresh: boolean;
      }
    | {
        kind: "resources";
        before: ProjectResources["production"];
        values: { cpuCores: number; memoryMb: number };
      }
    | { kind: "remove-binding"; connectionId: string }
    | { kind: "connections-saved" }
  );

export type DeploymentIntent = "refresh" | "update";

export interface TopologyChangePorts {
  listServices: () => Promise<Service[]>;
  createService: (input: ServiceInput) => Promise<Service>;
  startService: (id: string) => Promise<void>;
  updateService: (id: string, patch: Partial<ServiceInput>) => Promise<void>;
  readResources: () => Promise<ProjectResources>;
  updateResources: (values: { cpuCores: number; memoryMb: number }) => Promise<void>;
  removeBinding: (id: string) => Promise<void>;
  deploy: (input: {
    refresh?: boolean;
    forceAll?: boolean;
    serviceIds?: string[];
  }) => Promise<unknown>;
}

/** A refresh must reuse the running artifacts. New source/image configuration needs a build. */
export function canRefreshChanges(changes: readonly TopologyChange[]): boolean {
  return changes.every(
    (change) =>
      change.kind !== "create-service" && (change.kind !== "update-service" || change.refresh),
  );
}

/** Match the existing Add service flow: image companions launch independently. */
export function canStartAddedServices(changes: readonly TopologyChange[]): boolean {
  return (
    changes.length > 0 &&
    changes.every(
      (change) =>
        change.kind === "create-service" &&
        !!change.input.image &&
        !change.input.build &&
        change.input.kind !== "monorepo" &&
        change.input.enabled !== false,
    )
  );
}

/** Disabled containers are reconciled by the existing environment deployment. */
export function changesAffectEnvironment(changes: readonly TopologyChange[]): boolean {
  return changes.some(
    (change) =>
      change.kind === "resources" ||
      change.kind === "remove-binding" ||
      change.kind === "connections-saved" ||
      (change.kind === "create-service" && change.input.enabled === false) ||
      (change.kind === "update-service" &&
        (change.patch.enabled ?? change.before.enabled) === false),
  );
}

function orderAddedServices(
  changes: readonly TopologyChange[],
): Extract<TopologyChange, { kind: "create-service" }>[] {
  const pending = changes.filter(
    (change): change is Extract<TopologyChange, { kind: "create-service" }> =>
      change.kind === "create-service",
  );
  const ordered: typeof pending = [];
  while (pending.length) {
    const index = pending.findIndex(
      (change) =>
        !(change.input.dependsOn ?? []).some((name) =>
          pending.some((other) => other.input.name === name),
        ),
    );
    if (index < 0)
      throw new Error(
        "New services have a circular startup dependency. Review their configuration first.",
      );
    ordered.push(...pending.splice(index, 1));
  }
  return ordered;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => sameValue(left[key], right[key]))
    );
  }
  return false;
}

/** Runtime options can reuse the retained artifact; changed build inputs cannot. */
export function canRefreshServicePatch(service: Service, patch: Partial<ServiceInput>): boolean {
  const sourceFields = [
    "image",
    "build",
    "dockerfile",
    "buildArgs",
    "rootDirectory",
    "framework",
    "packageManager",
    "installCommand",
    "buildCommand",
    "startCommand",
    "outputDirectory",
    "buildImage",
  ] as const;
  return sourceFields.every((key) => !(key in patch) || sameValue(service[key], patch[key]));
}

function validateStartupChanges(
  services: readonly Service[],
  changes: readonly TopologyChange[],
): void {
  const unsaved = changes.filter((change) => !change.saved);
  const preview = services.map((service) => {
    const change = unsaved.find(
      (item): item is Extract<TopologyChange, { kind: "update-service" }> =>
        item.kind === "update-service" && item.serviceId === service.id,
    );
    return change
      ? {
          ...service,
          name: change.patch.name ?? service.name,
          dependsOn: change.patch.dependsOn ?? service.dependsOn,
        }
      : service;
  });
  for (const change of unsaved)
    if (change.kind === "create-service") preview.push(serviceFromInput(change.id, change.input));
  for (const change of unsaved) {
    const source =
      change.kind === "create-service"
        ? preview.find((service) => service.id === change.id)
        : change.kind === "update-service" && change.patch.dependsOn
          ? preview.find((service) => service.id === change.serviceId)
          : undefined;
    if (!source) continue;
    const withoutOwnEdges = preview.map((service) =>
      service.id === source.id ? { ...service, dependsOn: [] } : service,
    );
    for (const name of source.dependsOn ?? []) {
      const target = preview.find((service) => service.name === name);
      if (!target)
        throw new Error(
          `${source.name}: startup dependency ${name} no longer exists. Review its configuration.`,
        );
      const problem = dependencyProblem(withoutOwnEdges, source.id, target.id);
      if (problem) throw new Error(`${source.name}: ${problem}`);
    }
  }
}

/** Only compare fields this change owns; unrelated edits do not block the review. */
export function serviceChangeConflicts(
  change: Extract<TopologyChange, { kind: "update-service" }>,
  current: Service,
): boolean {
  for (const key of Object.keys(change.patch) as (keyof ServiceInput)[]) {
    if (key === "kind") continue;
    if (key === "advanced" && change.patch.advanced) {
      for (const advancedKey of Object.keys(change.patch.advanced)) {
        const before = change.before.advanced as Record<string, unknown> | null | undefined;
        const latest = current.advanced as Record<string, unknown> | null | undefined;
        if (!sameValue(before?.[advancedKey], latest?.[advancedKey])) return true;
      }
    } else if (!sameValue(change.before[key as keyof Service], current[key as keyof Service]))
      return true;
  }
  return false;
}

/** Preserve the first reviewed baseline when an operator adjusts a pending change. */
export function stageServiceChange(
  changes: readonly TopologyChange[],
  service: Service,
  patch: Partial<ServiceInput>,
  refresh: boolean,
): TopologyChange[] {
  const pending = changes.find(
    (change): change is Extract<TopologyChange, { kind: "create-service" }> =>
      change.kind === "create-service" && change.id === service.id,
  );
  if (pending) {
    if (pending.saved)
      throw new Error("Finish applying the saved service before editing it again.");
    const advanced = { ...pending.input.advanced, ...patch.advanced } as Record<string, unknown>;
    for (const key of Object.keys(advanced)) if (advanced[key] === null) delete advanced[key];
    return changes.map((change) =>
      change.id === pending.id
        ? {
            ...pending,
            title: `Add ${patch.name || pending.input.name}`,
            input: { ...pending.input, ...patch, advanced } as ServiceInput,
          }
        : change,
    );
  }
  const id = `update:${service.id}`;
  const existing = changes.find(
    (change): change is Extract<TopologyChange, { kind: "update-service" }> =>
      change.id === id && change.kind === "update-service",
  );
  if (existing?.saved) throw new Error("Deploy the saved configuration before editing it again.");
  const combined = existing
    ? {
        ...existing.patch,
        ...patch,
        ...(existing.patch.advanced || patch.advanced
          ? { advanced: { ...existing.patch.advanced, ...patch.advanced } }
          : {}),
      }
    : patch;
  const updated: TopologyChange = {
    id,
    kind: "update-service",
    serviceId: service.id,
    before: existing?.before ?? service,
    patch: combined,
    refresh: (existing?.refresh ?? true) && refresh,
    title: `Update ${service.name}`,
  };
  return [...changes.filter((change) => change.id !== id), updated];
}

/**
 * Save through the same APIs as the Services list, then use the deployment
 * pipeline. Receipts are emitted after EACH successful write, so a retry never
 * creates a service twice or pretends a partial save was rolled back.
 */
export async function applyTopologyChanges({
  changes,
  intent,
  deployed,
  serviceIds,
  ports,
  onSaved,
}: {
  changes: readonly TopologyChange[];
  intent: DeploymentIntent;
  deployed: boolean;
  serviceIds?: string[];
  ports: TopologyChangePorts;
  onSaved: (change: TopologyChange) => void;
}): Promise<{ deployment?: unknown; needsSetup?: true; startedServices?: string[] }> {
  if (intent === "refresh" && (!deployed || !canRefreshChanges(changes))) {
    throw new Error("These changes need a new deployment; the current release cannot be reused.");
  }

  const services = await ports.listServices();
  for (const serviceId of serviceIds ?? []) {
    if (!services.some((service) => service.id === serviceId && service.enabled)) {
      throw new Error("A selected service was removed or disabled. Refresh before deploying.");
    }
  }
  const directStart = canStartAddedServices(changes);
  // New dependencies must exist before their consumers are created or updated.
  // Validate that order before writing anything, including on a mixed review.
  const orderedChanges = [
    ...orderAddedServices(changes),
    ...changes.filter((change) => change.kind !== "create-service"),
  ];
  validateStartupChanges(services, changes);
  if (
    deployed &&
    changes.some((change) => change.kind === "update-service" && change.patch.enabled === false)
  ) {
    const enabledAfterReview =
      services.some((service) => {
        const change = changes.find(
          (item): item is Extract<TopologyChange, { kind: "update-service" }> =>
            item.kind === "update-service" && item.serviceId === service.id,
        );
        return change?.patch.enabled ?? service.enabled;
      }) ||
      changes.some((change) => change.kind === "create-service" && change.input.enabled !== false);
    if (!enabledAfterReview)
      throw new Error(
        "Keep at least one service enabled to deploy this environment. To pause a running service, use its Stop action.",
      );
  }
  const names = new Set(services.map((service) => service.name));
  for (const change of changes.filter((item) => !item.saved)) {
    if (change.kind === "create-service") {
      if (names.has(change.input.name))
        throw new Error(
          `A service named ${change.input.name} already exists. Refresh and choose a different name.`,
        );
      names.add(change.input.name);
    }
    if (change.kind === "update-service") {
      const current = services.find((service) => service.id === change.serviceId);
      if (!current)
        throw new Error(
          `${change.before.name} was removed. Refresh the topology before applying changes.`,
        );
      if (serviceChangeConflicts(change, current))
        throw new Error(
          `${change.before.name} changed since this review started. Discard its pending edit and refresh before trying again.`,
        );
    }
    if (change.kind === "resources") {
      const current = await ports.readResources();
      if (!sameValue(change.before, current.production))
        throw new Error(
          "Resource settings changed since this review started. Refresh and review the new values.",
        );
    }
  }

  const affected = new Set(serviceIds ?? []);
  const committed: TopologyChange[] = [];
  const wholeEnvironment =
    changesAffectEnvironment(changes) || (!changes.length && !serviceIds?.length);
  for (const change of orderedChanges) {
    if (change.kind === "update-service") affected.add(change.serviceId);
    if (change.kind === "create-service" && change.createdServiceId)
      affected.add(change.createdServiceId);
    if (change.saved) {
      committed.push(change);
      continue;
    }
    let saved: TopologyChange = { ...change, saved: true };
    switch (change.kind) {
      case "create-service": {
        const service = await ports.createService(change.input);
        affected.add(service.id);
        saved = { ...change, saved: true, createdServiceId: service.id };
        break;
      }
      case "update-service":
        await ports.updateService(change.serviceId, change.patch);
        break;
      case "resources":
        await ports.updateResources(change.values);
        break;
      case "remove-binding":
        await ports.removeBinding(change.connectionId);
        break;
      case "connections-saved":
        break;
    }
    onSaved(saved);
    committed.push(saved);
  }
  if (!deployed) return { needsSetup: true };
  if (directStart) {
    const startedServices: string[] = [];
    for (const change of orderAddedServices(committed)) {
      if (!change.createdServiceId)
        throw new Error("The new service identity could not be resolved.");
      if (!change.started) {
        await ports.startService(change.createdServiceId);
        onSaved({ ...change, started: true });
      }
      startedServices.push(change.createdServiceId);
    }
    return { startedServices };
  }
  const deployment = await ports.deploy({
    ...(intent === "refresh"
      ? { refresh: true, ...(wholeEnvironment ? { forceAll: true } : {}) }
      : { forceAll: true }),
    ...(!wholeEnvironment && affected.size ? { serviceIds: [...affected] } : {}),
  });
  return { deployment };
}

/** Pending node previews are marked explicitly; they never masquerade as runtime state. */
export function serviceFromInput(id: string, input: ServiceInput): Service {
  return {
    id,
    kind: input.kind ?? "compose",
    name: input.name,
    image: input.image ?? null,
    build: input.build ?? null,
    dockerfile: input.dockerfile ?? null,
    buildArgs: input.buildArgs ?? {},
    ports: input.ports ?? [],
    dependsOn: input.dependsOn ?? [],
    environment: (input.environment as Record<string, string>) ?? {},
    volumes: input.volumes ?? [],
    command: input.command ?? null,
    restart: input.restart ?? "unless-stopped",
    exposed: input.exposed ?? false,
    exposedPort: input.exposedPort ?? null,
    domain: input.domain ?? null,
    customDomain: input.customDomain ?? null,
    domainType: input.domainType ?? null,
    enabled: input.enabled ?? true,
    sortOrder: input.sortOrder ?? 0,
    advanced: input.advanced as Service["advanced"],
    ...(input.kind === "monorepo"
      ? { rootDirectory: input.rootDirectory, framework: input.framework }
      : {}),
  };
}
