import {
  composeNamespaceDependencies,
  parseComposeNamespace,
  type ComposeAdvanced,
} from "@repo/core";

export interface ExactServiceTargetRow {
  id: string;
  name: string;
  enabled: boolean;
  advanced?: unknown;
}

/**
 * Validate an exclusive deployment target set against one current project
 * snapshot. Missing/disabled IDs fail closed. A selected namespace provider
 * also requires its enabled dependents because replacing the provider destroys
 * the namespace handle those containers joined.
 */
export function assertExactServiceTargets(
  services: ExactServiceTargetRow[],
  requested: string[],
  subject = "Deployment",
): void {
  const enabled = services.filter((service) => service.enabled);
  const availableIds = new Set(enabled.map((service) => service.id));
  const unavailable = requested.filter((id) => !availableIds.has(id));
  if (unavailable.length > 0) {
    throw new Error(
      `${subject} targets missing, disabled, or cross-project services: ${unavailable.join(", ")}`,
    );
  }

  const selectedIds = new Set(requested);
  const byName = new Map(enabled.map((service) => [service.name, service]));

  // A selected namespace consumer cannot be deployed without its provider.
  // Validate this while the cohort is still only a plan; discovering it in the
  // per-service activation loop can otherwise replace an unrelated selected
  // service before rejecting this one.
  for (const service of enabled.filter((candidate) => selectedIds.has(candidate.id))) {
    const advanced = service.advanced as ComposeAdvanced | null;
    for (const [value, field] of [
      [advanced?.networkMode, "network_mode"],
      [advanced?.pidMode, "pid"],
    ] as const) {
      const parsed = parseComposeNamespace(value, field);
      if (parsed && !parsed.ok) {
        throw new Error(`${subject} target "${service.name}" has invalid ${parsed.reason}`);
      }
      if (!parsed?.ok || parsed.ref.kind !== "service") continue;
      if (parsed.ref.service === service.name) {
        throw new Error(
          `${subject} target "${service.name}" has ${field}: service:${service.name}, which refers to itself`,
        );
      }
      if (!byName.has(parsed.ref.service)) {
        throw new Error(
          `${subject} target "${service.name}" requires missing or disabled namespace service "${parsed.ref.service}"`,
        );
      }
    }
  }

  // Namespace sharing must form a DAG. The runtime's topological ordering can
  // break ordinary `depends_on` cycles, but a namespace cycle is impossible to
  // start: each container needs the other container's namespace to exist first.
  // Restrict the graph to this exact cohort so a direct Start is not blocked by
  // an unrelated project's dormant configuration problem.
  const selectedByName = new Map(
    enabled
      .filter((service) => selectedIds.has(service.id))
      .map((service) => [service.name, service]),
  );
  const visitState = new Map<string, "visiting" | "visited">();
  const path: string[] = [];
  const visit = (serviceName: string): void => {
    const state = visitState.get(serviceName);
    if (state === "visited") return;
    if (state === "visiting") {
      const cycleStart = path.indexOf(serviceName);
      const cycle = [...path.slice(cycleStart), serviceName];
      throw new Error(`${subject} target set contains a namespace cycle: ${cycle.join(" -> ")}`);
    }

    visitState.set(serviceName, "visiting");
    path.push(serviceName);
    const service = selectedByName.get(serviceName)!;
    for (const providerName of new Set(
      composeNamespaceDependencies(service.advanced as ComposeAdvanced | null),
    )) {
      if (selectedByName.has(providerName)) visit(providerName);
    }
    path.pop();
    visitState.set(serviceName, "visited");
  };
  for (const serviceName of selectedByName.keys()) visit(serviceName);

  const missingLinked = new Set<string>();
  for (const dependent of enabled) {
    for (const providerName of composeNamespaceDependencies(
      dependent.advanced as ComposeAdvanced | null,
    )) {
      const provider = byName.get(providerName);
      if (provider && selectedIds.has(provider.id) && !selectedIds.has(dependent.id)) {
        missingLinked.add(dependent.id);
      }
    }
  }
  if (missingLinked.size > 0) {
    throw new Error(
      `${subject} target set must also include namespace-linked services: ${[...missingLinked].join(", ")}`,
    );
  }
}
