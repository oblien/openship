import { api } from "./client";
import { endpoints } from "./endpoints";
import type { ComposeAdvanced, ComposeAdvancedPatch } from "@repo/core";

export type { ComposeAdvanced, ComposeAdvancedPatch, ComposeHealthcheck, OpenshipReadiness } from "@repo/core";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Narrow a service row's `kind` to the discriminator type. Anything that
 * isn't "monorepo" is treated as "compose" - matches the backend default
 * and the schema's nullable column. One helper so dashboard sites don't
 * hand-roll the same `kind === "monorepo" ? "monorepo" : "compose"`
 * ternary inline.
 */
export function serviceKind(
  service: { kind?: "compose" | "monorepo" | string | null } | null | undefined,
): "compose" | "monorepo" {
  return service?.kind === "monorepo" ? "monorepo" : "compose";
}

/**
 * Order services with a public domain (exposed / publicly-routed) first, so the
 * ones a user actually browses to lead the list — in the project service list,
 * the logs target picker, etc. Stable: within each group the original order
 * (the compose sortOrder) is preserved, so it's display-only and doesn't affect
 * deploy ordering (which is resolved server-side by dependency topo-sort).
 */
export function sortServicesByPublicFirst<T extends { exposed?: boolean | null }>(
  services: readonly T[],
): T[] {
  return [...services].sort((a, b) => Number(!!b.exposed) - Number(!!a.exposed));
}

/**
 * Does this service go through the full build+deploy pipeline, or is it a pure
 * IMAGE "app" that just launches? This is the single source of truth for the
 * two-mode service UI split so call sites can't drift:
 *   - PIPELINE (true): compose stack, monorepo sub-app, or anything that BUILDS
 *     from source → keeps per-service Redeploy (build page) + reload-env.
 *   - APP (false): an image app added to a normal/static project → Start/Stop,
 *     internal IP, no Redeploy, no build page.
 */
export function serviceUsesDeployPipeline(
  service: { kind?: "compose" | "monorepo" | string | null; build?: string | null },
  projectType?: string | null,
): boolean {
  return (
    projectType === "services" ||
    projectType === "monorepo" ||
    serviceKind(service) === "monorepo" ||
    Boolean(service.build)
  );
}

/**
 * Can this service be launched by the decoupled Start path (pull image + run)?
 * A source-built service with no image can't — it only builds through the
 * deploy pipeline, so it must be started via Redeploy rather than Start.
 */
export function serviceCanStartWithoutBuild(
  service: { build?: string | null; image?: string | null },
): boolean {
  return !(service.build && !service.image);
}

export interface Service {
  id: string;
  /** Discriminator. "compose" (default) or "monorepo" sub-app. */
  kind?: "compose" | "monorepo";
  name: string;
  image: string | null;
  build: string | null;
  dockerfile: string | null;
  ports: string[] | null;
  dependsOn: string[] | null;
  environment: Record<string, string> | null;
  volumes: string[] | null;
  command: string | null;
  restart: string | null;
  /** Extended compose fields (healthcheck, …) stored as one JSONB blob. */
  advanced?: ComposeAdvanced | null;
  exposed: boolean;
  exposedPort: string | null;
  domain: string | null;
  customDomain: string | null;
  domainType: "free" | "custom" | null;
  /** Additional public routes (one per port). Entry[0] mirrors the scalars. */
  publicEndpoints?: Array<{
    port: number;
    domainType: "free" | "custom";
    domain?: string;
    customDomain?: string;
  }> | null;
  enabled: boolean;
  sortOrder: number;
  /* ── Monorepo sub-app fields (kind === "monorepo" only) ─────────── */
  rootDirectory?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  outputDirectory?: string | null;
  framework?: string | null;
  packageManager?: string | null;
  buildImage?: string | null;
  /** Pending upstream compose drift (repo changed a field the user had edited).
   *  Null when nothing needs review. Set by the redeploy reconciler. */
  drift?: ServiceDrift | null;
}

/** A pending upstream compose change awaiting review (accept upstream / keep mine). */
export interface ServiceDrift {
  changes: Array<{ field: string; from: unknown; to: unknown }>;
}

/** A service's LIVE runtime view — read off the host on every request, never
 *  from the deploy-time status column. `status` is
 *  running | starting | restarting | stopped | failed | unknown
 *  ("unknown" = the host couldn't be reached, not a claim about the service). */
export interface ServiceContainer {
  serviceId: string;
  serviceName: string;
  containerId: string | null;
  status: string;
  ip: string | null;
  hostPort: number | null;
  imageRef: string | null;
  /** Which identity key matched the container: label | name | trackedId | compose. */
  matchedBy?: "label" | "name" | "trackedId" | "compose" | null;
  /** Other containers on the host that also answer to this service (leftovers). */
  duplicates?: string[];
}

export interface ServiceVolumeSize {
  /** The compose volume string, verbatim — aligned by index to service.volumes. */
  raw: string;
  source: string;
  target: string | null;
  kind: "named" | "bind" | "anonymous";
  readOnly: boolean;
  /** On-disk size in bytes (apparent), or null when it couldn't be measured. */
  bytes: number | null;
}

export interface ServiceVolumeSizes {
  /** False for cloud/undeployed services (no host to `du` on) → hide sizes. */
  measurable: boolean;
  volumes: ServiceVolumeSize[];
  /** Sum of measured volumes, or null if none measured. */
  totalBytes: number | null;
  /** True when a volume couldn't be measured → totalBytes is a lower bound (≥). */
  partial: boolean;
}

export interface ServiceEnvVar {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
  environment: string;
}

export type ServiceInput = {
  name: string;
  /**
   * Row discriminator. Pass "monorepo" to create a source-built sub-app
   * (requires rootDirectory). Defaults to "compose" if omitted, matching
   * the backend default and historical behavior.
   */
  kind?: "compose" | "monorepo";
  image?: string;
  build?: string;
  dockerfile?: string;
  ports?: string[];
  dependsOn?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  command?: string;
  restart?: string;
  advanced?: ComposeAdvancedPatch;
  exposed?: boolean;
  exposedPort?: string;
  domain?: string;
  customDomain?: string;
  domainType?: "free" | "custom";
  /** Additional public routes (one per port). Entry[0] mirrors the scalars. */
  publicEndpoints?: Array<{
    port?: number | string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  enabled?: boolean;
  sortOrder?: number;
  /* ── Monorepo sub-app build settings (kind="monorepo" only) ─────────
   * Optional so existing compose service create/update calls don't need
   * to change. Backend (UpdateServiceBody schema) accepts the same set. */
  rootDirectory?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  framework?: string;
  packageManager?: string;
  buildImage?: string;
};

/* ------------------------------------------------------------------ */
/*  Services API (compose / multi-service projects)                   */
/* ------------------------------------------------------------------ */

export const servicesApi = {
  /** List all services for a project */
  list: (projectId: string | number) =>
    api.get<{ success: boolean; services: Service[] }>(endpoints.services.list(projectId)),

  /** Get a single service */
  get: (projectId: string | number, serviceId: string) =>
    api.get<{ success: boolean; service: Service }>(endpoints.services.get(projectId, serviceId)),

  /** Measure the on-disk size of a service's volumes (runs `du` on the host —
   *  loaded lazily from the Overview tab, not polled). Aligned by index to
   *  `service.volumes`. `measurable:false` for cloud/undeployed → no sizes. */
  volumeSizes: (projectId: string | number, serviceId: string) =>
    api.get<{ success: boolean } & ServiceVolumeSizes>(
      endpoints.services.volumeSizes(projectId, serviceId),
    ),

  /** Create a service manually */
  create: (projectId: string | number, data: ServiceInput) =>
    api.post<{ success: boolean; service: Service }>(endpoints.services.create(projectId), data),

  /**
   * Update a service configuration.
   *
   * Strips `kind` from the payload because the backend's UpdateServiceBody
   * validator rejects it - flipping a row's kind would invalidate the
   * "compose-rows-have-null-monorepo-fields" invariant and bypass the
   * create-time rootDirectory guard. Switching kind is a delete+recreate
   * operation, not a patch. Stripping client-side is the cheapest way to
   * keep the ServiceEditorModal payload shape uniform between create
   * and edit without sprouting kind-omitting branches all over.
   */
  update: (
    projectId: string | number,
    serviceId: string,
    data: Partial<ServiceInput>,
  ) => {
    // Strip `kind` defensively. The backend validator rejects unknown
    // and disallowed keys (additionalProperties:false on UpdateServiceBody),
    // but stripping client-side keeps a uniform payload shape between
    // the modal's create and edit branches.
    const { kind: _kind, ...rest } = data as { kind?: unknown } & Record<string, unknown>;
    return api.patch<{ success: boolean; service: Service }>(
      endpoints.services.update(projectId, serviceId),
      rest,
    );
  },

  /** Delete a service */
  delete: (projectId: string | number, serviceId: string) =>
    api.delete<{ success: boolean }>(endpoints.services.delete(projectId, serviceId)),

  /** Sync services from compose file parse result */
  sync: (projectId: string | number, services: ServiceInput[]) =>
    api.post<{ success: boolean; services: Service[] }>(endpoints.services.sync(projectId), {
      services,
    }),

  /** Get active containers for all services */
  containers: (projectId: string | number) =>
    api.get<{ success: boolean; containers: ServiceContainer[] }>(
      endpoints.services.containers(projectId),
    ),

  /** Get environment variables for a service */
  getEnv: (projectId: string | number, serviceId: string, environment?: string) =>
    api.get<{ success: boolean; vars: ServiceEnvVar[] }>(
      `${endpoints.services.envGet(projectId, serviceId)}${environment ? `?environment=${environment}` : ""}`,
    ),

  /** #336: real (unmasked) compose `environment` map — write-gated on the API. */
  revealEnv: (projectId: string | number, serviceId: string) =>
    api.get<{ success: boolean; environment: Record<string, string> }>(
      endpoints.services.envReveal(projectId, serviceId),
    ),

  /** Set environment variables for a service */
  setEnv: (
    projectId: string | number,
    serviceId: string,
    data: {
      environment: string;
      vars: Array<{ key: string; value: string; isSecret?: boolean }>;
    },
  ) =>
    api.put<{ success: boolean; count: number }>(
      endpoints.services.envSet(projectId, serviceId),
      data,
    ),

  /** Start a service. If it has no container yet, this PROVISIONS it (pull image
   *  + create the container/workspace) — which can take a while — so use a long
   *  timeout. Decoupled from the project deploy pipeline (no build page). */
  start: (projectId: string | number, serviceId: string) =>
    api.post<{ success: boolean; containerId?: string }>(
      endpoints.services.start(projectId, serviceId),
      undefined,
      { timeout: 120_000 },
    ),

  /** Stop a service container */
  stop: (projectId: string | number, serviceId: string) =>
    api.post<{ success: boolean }>(endpoints.services.stop(projectId, serviceId)),

  /** Restart a service container */
  restart: (projectId: string | number, serviceId: string) =>
    api.post<{ success: boolean }>(endpoints.services.restart(projectId, serviceId)),

  /** Accept the pending upstream compose change (apply repo values, clear drift) */
  acceptDrift: (projectId: string | number, serviceId: string) =>
    api.post<{ success: boolean; service: Service }>(
      endpoints.services.driftAccept(projectId, serviceId),
    ),

  /** Keep the user's edits (advance baseline, clear drift without changing values) */
  keepDrift: (projectId: string | number, serviceId: string) =>
    api.post<{ success: boolean; service: Service }>(
      endpoints.services.driftKeep(projectId, serviceId),
    ),
};
