import { firstServicePort } from "../service-routing";

/** One endpoint's routing choice, exactly as the install wizard asked it. */
export interface InstallAppRoute {
  /** Template service name. */
  service: string;
  /** Container port this choice routes. */
  port: number;
  /** port = no public route (published host port only). */
  mode: "port" | "free" | "custom";
  /** free mode: subdomain slug. Blank = the template's default label. */
  domain?: string;
  /** custom mode: the hostname the operator owns (required). */
  customDomain?: string;
}

/**
 * Turn one catalog-authored port spec into the deliberate public binding that
 * an install-wizard `mode:"port"` choice promises.
 *
 * Docker runtime ports default to loopback in Openship (a bare `8080:80` must
 * not bypass the edge accidentally), so the all-interface address has to be
 * explicit here. A template that already pins an interface made a stronger
 * author decision and is preserved verbatim.
 */
function publicInstallPortSpec(spec: string, containerPort: number): string {
  const slash = spec.lastIndexOf("/");
  const protocol = slash >= 0 ? spec.slice(slash) : "";
  const mapping = (slash >= 0 ? spec.slice(0, slash) : spec).trim();
  const parts = mapping.split(":");
  if (parts.length >= 3) return spec;

  const authoredHostPort = parts.length === 2 ? parts[0]?.trim() : undefined;
  const hostPort = authoredHostPort || String(containerPort);
  return `0.0.0.0:${hostPort}:${containerPort}${protocol}`;
}

/**
 * Compose port specs for one installed service after applying the operator's
 * explicit HTTP endpoint choices.
 *
 * `routes` / `exposedPort` say what a container SERVES; they do not create a
 * Docker host binding. Domain mode is fronted by the edge, while port-only mode
 * needs a fixed public binding so both the advertised URL and
 * `{{publicUrl:service}}` are truthful.
 *
 * On an adopted failed draft, `storedPorts` may contain bindings written by an
 * earlier attempt. Reconciliation is reversible: switching an endpoint back to
 * domain mode restores its catalog-authored spec, or removes the exact
 * same-port binding this helper generated when the catalog declared none. Other
 * mappings are never touched.
 */
export function installServicePorts(
  serviceName: string,
  templatePorts: readonly string[] | null | undefined,
  routes: readonly InstallAppRoute[] | undefined,
  storedPorts: readonly string[] | null | undefined = templatePorts,
  target: "server" | "cloud" = "server",
): string[] {
  const choices = (routes ?? []).filter((route) => route.service === serviceName);
  let next = [...(storedPorts ?? templatePorts ?? [])];
  if (choices.length === 0) return next;

  for (const choice of choices) {
    // Cloud ingress is domain-routed. Its "No domain" choice means internal,
    // not a host binding that the runtime will silently discard. Remove only
    // the endpoint being configured; unrelated service ports remain untouched.
    if (target === "cloud") {
      next = next.filter((spec) => firstServicePort([spec]) !== choice.port);
      continue;
    }
    const authored = (templatePorts ?? []).filter(
      (spec) => firstServicePort([spec]) === choice.port,
    );

    if (choice.mode === "port") {
      let covered = false;
      next = next.map((spec) => {
        if (firstServicePort([spec]) !== choice.port) return spec;
        covered = true;
        return publicInstallPortSpec(spec, choice.port);
      });
      if (!covered) next.push(`0.0.0.0:${choice.port}:${choice.port}`);
      continue;
    }

    // Undo only transformations this helper can prove it owns. An arbitrary
    // operator-authored remap remains intact; without ownership metadata,
    // guessing here could close an unrelated port.
    const restorations = new Map<string, string[]>();
    for (const spec of authored) {
      const published = publicInstallPortSpec(spec, choice.port);
      if (published === spec) continue;
      const originals = restorations.get(published) ?? [];
      originals.push(spec);
      restorations.set(published, originals);
    }
    const generated = authored.length === 0 ? `0.0.0.0:${choice.port}:${choice.port}` : null;
    next = next.flatMap((spec) => {
      if (firstServicePort([spec]) !== choice.port) return [spec];
      const originals = restorations.get(spec);
      const original = originals?.shift();
      if (original) return [original];
      if (generated === spec) return [];
      return [spec];
    });
  }

  // A restored authored spec can already coexist with the old copy on a
  // partially edited draft. Exact duplicates have no Docker meaning and can
  // produce duplicate PortBindings, so make this pure reconciliation idempotent.
  return [...new Set(next)];
}

export interface AppInstallEndpoint {
  port: number;
  domainType: "free" | "custom";
  domain?: string;
  customDomain?: string;
}

/**
 * One plan entry as an `updateService` patch.
 *
 * Exists because the array is not optional. A patch carrying only `domainType` loses to
 * the stored `publicEndpoints`, which is how a corrected custom domain came back as the
 * old free route — so every writer has to send the FULL array, and a rule that every
 * writer has to remember belongs in one place instead. Both the install path and the
 * webmail re-apply path spelled this out separately.
 */
export function serviceRoutingPatch(routing: {
  exposed: boolean;
  publicEndpoints: AppInstallEndpoint[];
}): {
  exposed: boolean;
  publicEndpoints: AppInstallEndpoint[];
  domainType?: "free" | "custom";
  domain?: null;
  customDomain?: null;
} {
  const primary = routing.publicEndpoints[0];
  return {
    exposed: routing.exposed,
    publicEndpoints: routing.publicEndpoints,
    ...(primary
      ? // The scalar column mirrors entry[0] — the template's primary route.
        { domainType: primary.domainType }
      : // An empty plan is a DECISION, not an absence — the webmail proxy variant's
        // deliberate no-hostname. Omitting the scalars made it unsayable: for an
        // existing row `mergeServiceRoutingPatch` resolves an absent `domainType`
        // from `stored`, so `"custom"` survived, and `customDomain` then resolved
        // from `stored` too. The array cleared while the row kept the hostname it
        // was redeployed to drop — alive in its derived domain row.
        { domainType: "free" as const, domain: null, customDomain: null }),
  };
}
