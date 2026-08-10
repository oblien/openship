import { eq, and, asc, inArray } from "drizzle-orm";
import { commandToArgv, generateId, mergeAdvanced, normalizeCustomHostname, type ComposeAdvanced } from "@repo/core";
import type { Database } from "../client";
import { service, serviceDeployment } from "../schema";
import type { ComposeServiceSpec, ServicePublicEndpoint } from "../schema/service";

/** A public route as it arrives on the wire (port may be a string) before
 *  normalization into a {@link ServicePublicEndpoint}. */
export type PublicEndpointInputLike = {
  port?: number | string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: string | null;
  targetPath?: string | null;
};

// ─── Types ───────────────────────────────────────────────────────────────────

export type Service = typeof service.$inferSelect;
export type NewService = typeof service.$inferInsert;
export type ServiceDeployment = typeof serviceDeployment.$inferSelect;
export type NewServiceDeployment = typeof serviceDeployment.$inferInsert;

// ─── Compose spec (drift 3-way merge) ──────────────────────────────────────────

/** The compose-owned fields, normalized so a parsed compose entry and a stored
 *  row compare identically. Routing is deliberately excluded (user-owned). */
export function toComposeSpec(s: {
  image?: string | null;
  build?: string | null;
  dockerfile?: string | null;
  ports?: string[] | null;
  dependsOn?: string[] | null;
  environment?: Record<string, string> | null;
  volumes?: string[] | null;
  command?: string | null;
  commandArgv?: string[] | null;
  restart?: string | null;
  advanced?: ComposeAdvanced | null;
}): ComposeServiceSpec {
  return {
    image: s.image ?? null,
    build: s.build ?? null,
    dockerfile: s.dockerfile ?? null,
    ports: s.ports ?? [],
    dependsOn: s.dependsOn ?? [],
    environment: s.environment ?? {},
    volumes: s.volumes ?? [],
    command: s.command ?? null,
    // #332: derive argv from the text `command` when a row has no explicit
    // `commandArgv` (legacy rows stored before the fix). This keeps drift
    // comparison representation-stable — a legacy row and its re-parse
    // canonicalize identically instead of flagging a phantom string↔argv change.
    commandArgv: s.commandArgv ?? commandToArgv(s.command ?? null),
    restart: s.restart ?? "unless-stopped",
    advanced: s.advanced ?? {},
  };
}

/**
 * Recursively sort object keys so two structurally-equal values stringify
 * identically, while preserving array order. This generalizes the old
 * environment-only sort: reordered maps (env, and now nested `advanced` blocks
 * like healthcheck/labels) must NOT read as drift, but ordered arrays (ports,
 * volumes, dependsOn, healthcheck argv) are order-significant and kept as-is.
 */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
};

const canonicalSpec = (s: ComposeServiceSpec): string =>
  JSON.stringify(canonicalize(toComposeSpec(s)));

/** Compose-field equality (ignores routing + ordering-insensitive env). */
export const composeSpecsEqual = (a: ComposeServiceSpec, b: ComposeServiceSpec) =>
  canonicalSpec(a) === canonicalSpec(b);

/**
 * The compose-owned fields as an UPDATE payload, with `advanced` MERGED onto the
 * stored blob rather than replacing it.
 *
 * `toComposeSpec` coerces a missing `advanced` to `{}`, which is right for the
 * drift comparison it exists for — a stored `{}` and an absent one have to
 * canonicalize identically — and destructive as a write: compose YAML has no
 * syntax for a readiness gate, generated config files, resource caps or an
 * east-west alias, so `{}` from the parser silently erased whatever the operator
 * or an app template had set. Every deploy carrying compose services did this.
 *
 * Deliberately NOT used by reconcileFromCompose: there, applying `theirs`
 * wholesale is the point — a key the operator deleted from the compose file
 * SHOULD disappear, and the 3-way merge against `importedSpec` is what decides
 * whether that is safe.
 */
function composeWritePatch(
  parsed: ParsedComposeService,
  stored?: { advanced?: ComposeAdvanced | null } | null,
): ComposeServiceSpec {
  return {
    ...toComposeSpec(parsed),
    advanced: mergeAdvanced(stored?.advanced ?? null, parsed.advanced),
  };
}

/** Per-field diff of two specs — powers the drift UI. */
export function composeSpecDiff(base: ComposeServiceSpec, next: ComposeServiceSpec) {
  const fields: (keyof ComposeServiceSpec)[] = [
    "image", "build", "dockerfile", "ports", "dependsOn", "environment", "volumes", "command", "commandArgv", "restart", "advanced",
  ];
  // Compare each field key-order-insensitively (matching canonicalSpec/
  // composeSpecsEqual) so a reordered `environment` or nested `advanced` block
  // doesn't show as a phantom change the reviewer can't resolve.
  const changed: { field: string; from: unknown; to: unknown }[] = [];
  const b = toComposeSpec(base);
  const n = toComposeSpec(next);
  for (const f of fields) {
    if (JSON.stringify(canonicalize(b[f])) !== JSON.stringify(canonicalize(n[f]))) {
      changed.push({ field: f, from: b[f], to: n[f] });
    }
  }
  return changed;
}

/**
 * A service as parsed from a compose file (or the equivalent UI payload). Shared
 * by syncFromCompose (import) and reconcileFromCompose (redeploy). `kind` is
 * honored only when "compose"; monorepo entries are filtered out by both.
 */
export type ParsedComposeService = {
  name: string;
  kind?: string | null;
  image?: string;
  build?: string;
  dockerfile?: string;
  ports?: string[];
  dependsOn?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  command?: string;
  commandArgv?: string[] | null;
  restart?: string;
  advanced?: ComposeAdvanced;
  exposed?: boolean;
  exposedPort?: string;
  domain?: string;
  customDomain?: string;
  domainType?: string;
  /** Additional public routes (one per port). Entry[0] mirrors the scalars. */
  publicEndpoints?: PublicEndpointInputLike[];
};

// ─── Routing normalization ───────────────────────────────────────────────────

/**
 * Single normalization rule for the service-row routing columns
 * (`exposed`, `exposedPort`, `domain`, `customDomain`, `domainType`).
 *
 * Exported so the API layer (service.service.ts) can apply the SAME
 * normalization on patch input before persisting. Two divergent
 * implementations were drifting (one trimmed differently than the
 * other) - collapsing to a single source of truth here.
 */
function normalizeRoutePort(port?: number | string | null): number | null {
  const numeric = typeof port === "string" ? Number(port) : port;
  if (!Number.isFinite(numeric) || numeric == null) return null;
  if (numeric < 1 || numeric > 65535) return null;
  return Math.trunc(numeric);
}

/** Normalize a wire/UI public-endpoint array into stored {@link ServicePublicEndpoint}s:
 *  drop entries missing a valid port or their domain value, dedupe by port. */
export function normalizeServicePublicEndpoints(
  endpoints?: PublicEndpointInputLike[] | null,
): ServicePublicEndpoint[] {
  const out: ServicePublicEndpoint[] = [];
  const seenPorts = new Set<number>();
  for (const endpoint of endpoints ?? []) {
    const port = normalizeRoutePort(endpoint.port);
    if (port === null || seenPorts.has(port)) continue;
    const domainType = endpoint.domainType === "custom" ? "custom" : "free";
    const domain = domainType === "free" ? endpoint.domain?.trim() || undefined : undefined;
    const customDomain = domainType === "custom" ? normalizeCustomHostname(endpoint.customDomain ?? "") || undefined : undefined;
    if (domainType === "free" && !domain) continue;
    if (domainType === "custom" && !customDomain) continue;
    seenPorts.add(port);
    out.push({ port, domainType, ...(domain ? { domain } : {}), ...(customDomain ? { customDomain } : {}) });
  }
  return out;
}

export function normalizeRoutingFields(input: {
  exposed?: boolean | null;
  exposedPort?: string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: string | null;
  /** Multi-route array. When present + non-empty it WINS: entry[0] mirrors the
   *  scalar columns below, and the full set is stored on `publicEndpoints`.
   *
   *  This function does NOT merge: a caller holding a stored row is responsible
   *  for folding a scalar-only patch into the row's route set BEFORE calling
   *  (apps/api `mergeServiceRoutingPatch`), because array-wins would otherwise
   *  silently discard the scalars. */
  publicEndpoints?: PublicEndpointInputLike[] | null;
}): {
  exposed: boolean;
  exposedPort: string | null;
  domain: string | null;
  customDomain: string | null;
  domainType: string;
  publicEndpoints: ServicePublicEndpoint[];
} {
  const trimOrNull = (v?: string | null) => {
    const t = v?.trim();
    return t || null;
  };

  const endpoints = normalizeServicePublicEndpoints(input.publicEndpoints);

  // `exposed` is a GATE, not part of route identity. Unexposing PAUSES routing —
  // every route reader is gated on it (resolveServicePublicEndpoints returns [],
  // buildServiceRouteDomains returns [], the deploy's publicPort/publicSlug/
  // customDomain resolvers all bail) — so a paused row's config is inert and does
  // NOT need to be erased to stop serving. It used to be erased, which made an
  // expose toggle silently delete a multi-route set (and orphan its verified
  // domain rows), and made a drift reconcile that re-normalizes a paused row's own
  // routing wipe it. An explicit `exposed: false` is still AUTHORITATIVE over a
  // non-empty array: that array previously flipped the row back to exposed:true,
  // so it could never be paused at all.
  const exposed = input.exposed ?? endpoints.length > 0;

  // Multi-route wins. The primary (first) endpoint mirrors the scalar columns
  // so every single-route reader keeps working against the primary.
  if (endpoints.length > 0) {
    const primary = endpoints[0];
    return {
      exposed,
      exposedPort: String(primary.port),
      domain: primary.domainType === "free" ? primary.domain ?? null : null,
      customDomain: primary.domainType === "custom" ? primary.customDomain ?? null : null,
      domainType: primary.domainType,
      publicEndpoints: endpoints,
    };
  }

  const domainType = input.domainType === "custom" ? "custom" : "free";
  // Single-route (scalar) path — publicEndpoints stays [] and the primary route
  // is synthesized from these columns at read time (resolveServicePublicEndpoints).
  return {
    exposed,
    exposedPort: trimOrNull(input.exposedPort),
    domain: domainType === "free" ? trimOrNull(input.domain) : null,
    customDomain: domainType === "custom" ? normalizeCustomHostname(input.customDomain ?? "") || null : null,
    domainType,
    publicEndpoints: [],
  };
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServiceRepo(db: Database) {
  return {
    // ── Services ───────────────────────────────────────────────────────

    async findById(id: string) {
      return db.query.service.findFirst({
        where: eq(service.id, id),
      });
    },

    /** Batch id → display name, for naming services in list responses. */
    async listNamesByIds(ids: string[]): Promise<{ id: string; name: string }[]> {
      if (ids.length === 0) return [];
      return db.select({ id: service.id, name: service.name })
        .from(service)
        .where(inArray(service.id, ids));
    },

    async findByName(projectId: string, name: string) {
      return db.query.service.findFirst({
        where: and(eq(service.projectId, projectId), eq(service.name, name)),
      });
    },

    async listByProject(projectId: string) {
      return db.query.service.findMany({
        where: eq(service.projectId, projectId),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      });
    },

    /**
     * Batch variant of listByProject — one SQL round trip for N
     * projects. Used by getHome to eliminate the N+1.
     */
    async listByProjects(projectIds: string[]): Promise<Map<string, Service[]>> {
      if (projectIds.length === 0) return new Map();
      const rows = await db.query.service.findMany({
        where: inArray(service.projectId, projectIds),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      });
      const out = new Map<string, Service[]>();
      for (const id of projectIds) out.set(id, []);
      for (const row of rows) {
        const list = out.get(row.projectId);
        if (list) list.push(row);
      }
      return out;
    },

    async create(data: Omit<NewService, "id">) {
      const id = generateId("svc");
      const row = { id, ...data };
      await db.insert(service).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Service;
    },

    async update(id: string, data: Partial<NewService>) {
      await db
        .update(service)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(service.id, id));
    },

    async remove(id: string) {
      await db.delete(service).where(eq(service.id, id));
    },

    /**
     * Hard-delete every service row under a project. The FK on
     * `serviceDeployment.serviceId` cascades, so this also removes the
     * per-deployment service rows. Used by the project cleanup pipeline
     * after a soft-delete - without this, service rows would survive as
     * orphans (project soft-delete is logical only and never triggers the
     * FK cascade that would remove them automatically).
     */
    async deleteByProjectId(projectId: string) {
      await db.delete(service).where(eq(service.projectId, projectId));
    },

    /** List only the rows of one kind under a project. */
    async listByProjectKind(projectId: string, kind: "compose" | "monorepo") {
      return db.query.service.findMany({
        where: and(eq(service.projectId, projectId), eq(service.kind, kind)),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      });
    },

    /**
     * Sync monorepo sub-apps for a project. Mirrors `syncFromCompose` but for
     * `kind="monorepo"` rows - creates new, updates existing, removes stale
     * (matched by `name`, which is the sub-app's stable identifier). Leaves
     * compose rows in the same project untouched.
     */
    async syncMonorepoApps(
      projectId: string,
      apps: {
        name: string;
        rootDirectory: string;
        framework?: string | null;
        packageManager?: string | null;
        buildImage?: string | null;
        installCommand?: string | null;
        buildCommand?: string | null;
        startCommand?: string | null;
        outputDirectory?: string | null;
        port?: number | string | null;
        enabled?: boolean;
        exposed?: boolean;
        exposedPort?: string | null;
        domain?: string | null;
        customDomain?: string | null;
        domainType?: string | null;
        environment?: Record<string, string>;
      }[],
    ) {
      const existing = await this.listByProjectKind(projectId, "monorepo");
      const existingByName = new Map(existing.map((s) => [s.name, s]));
      const incomingNames = new Set(apps.map((a) => a.name));

      const results: Service[] = [];
      for (let i = 0; i < apps.length; i++) {
        const app = apps[i];
        const ex = existingByName.get(app.name);

        const routing = normalizeRoutingFields({
          exposed: app.exposed ?? ex?.exposed ?? true,
          exposedPort: app.exposedPort ?? ex?.exposedPort ?? (app.port != null ? String(app.port) : null),
          domain: app.domain ?? ex?.domain,
          customDomain: app.customDomain ?? ex?.customDomain,
          domainType: app.domainType ?? ex?.domainType,
        });

        const fields = {
          kind: "monorepo" as const,
          name: app.name,
          rootDirectory: app.rootDirectory,
          framework: app.framework ?? null,
          packageManager: app.packageManager ?? null,
          buildImage: app.buildImage ?? null,
          installCommand: app.installCommand ?? null,
          buildCommand: app.buildCommand ?? null,
          startCommand: app.startCommand ?? null,
          outputDirectory: app.outputDirectory ?? null,
          environment: app.environment ?? {},
          ...routing,
          enabled: app.enabled ?? true,
          sortOrder: i,
        };

        if (ex) {
          await this.update(ex.id, fields);
          results.push({ ...ex, ...fields, updatedAt: new Date() } as Service);
        } else {
          const created = await this.create({
            projectId,
            ...fields,
            // Compose-only fields stay null on monorepo rows.
            image: null,
            build: null,
            dockerfile: null,
            ports: [],
            dependsOn: [],
            volumes: [],
            command: null,
            restart: "unless-stopped",
          });
          results.push(created);
        }
      }

      // Remove monorepo rows that aren't in the incoming list (compose rows
      // are filtered out by listByProjectKind, so they survive).
      for (const ex of existing) {
        if (!incomingNames.has(ex.name)) {
          await this.remove(ex.id);
        }
      }

      return results;
    },

    /**
     * Sync services from a parsed compose file.
     *
     * SCOPED TO kind="compose" ONLY. Monorepo sub-app rows have their own
     * sync path (the monorepoApps ensure() flow) and must NOT be touched
     * here - removing rows not in the incoming compose list would otherwise
     * delete every monorepo sub-app on a compose-mode build of a mixed
     * project, and per-row fields would be stomped if a monorepo row shared
     * a name with a compose service.
     *
     * Also preserves the user's explicit `enabled` choice on updates -
     * compose's YAML doesn't carry an enabled flag, so re-syncing a row
     * the user disabled in the dashboard must keep it disabled.
     *
     * `removeMissing` (default true) controls whether compose rows absent from
     * `parsed` are hard-deleted. Deploy-time callers pass FALSE, because the
     * list they hand over is not authoritative about what should exist:
     *
     *   - On a ROLLBACK it is the TARGET release's frozen list, so a service
     *     added after that release would be deleted - and `serviceDeployment
     *     .serviceId` is ON DELETE CASCADE, so its entire deploy history across
     *     every release goes with it while its container keeps running.
     *   - On ANY compose deploy, `deployComposeServices` builds its de-listed
     *     reaper input from the ACTIVE deployment's `service_deployment` rows,
     *     and this sync runs first - so the cascade empties the reaper's input
     *     and the removed service's container is orphaned instead of stopped.
     *
     * Removal keeps its home in the explicit compose-reconcile path
     * (`reconcileFromCompose` below), which models a removal policy properly by
     * 3-way merging against `importedSpec` before deleting anything.
     */
    async syncFromCompose(
      projectId: string,
      parsed: ParsedComposeService[],
      opts?: { removeMissing?: boolean },
    ) {
      const removeMissing = opts?.removeMissing ?? true;
      // Defensive filter - even though every caller should already strip
      // non-compose entries before reaching here, an explicit kind="monorepo"
      // would otherwise insert a ghost compose row with the same name as the
      // real monorepo sub-app. Belt-and-suspenders.
      const composeParsed = parsed.filter((p) => !p.kind || p.kind === "compose");

      const all = await this.listByProject(projectId);
      const composeExisting = all.filter((s) => s.kind === "compose" || s.kind === null);
      const existingByName = new Map(composeExisting.map((s) => [s.name, s]));
      const incomingNames = new Set(composeParsed.map((s) => s.name));

      // Create or update
      const results: Service[] = [];
      for (let i = 0; i < composeParsed.length; i++) {
        const p = composeParsed[i];
        const ex = existingByName.get(p.name);

        const routing = normalizeRoutingFields({
          exposed: p.exposed ?? (ex?.exposed || false),
          exposedPort: p.exposedPort ?? ex?.exposedPort,
          domain: p.domain ?? ex?.domain,
          customDomain: p.customDomain ?? ex?.customDomain,
          domainType: p.domainType ?? ex?.domainType,
          publicEndpoints: p.publicEndpoints ?? ex?.publicEndpoints,
        });

        if (ex) {
          // Update existing - preserve the operator's `enabled` choice AND their
          // `sortOrder` (dashboard reordering); the compose YAML carries neither.
          // One computed patch for both the write and the echoed row, or the
          // returned Service would disagree with what was stored.
          const patch = composeWritePatch(p, ex);
          await this.update(ex.id, {
            ...patch,
            ...routing,
            // enabled + sortOrder left as-is (already on ex)
          });
          results.push({
            ...ex,
            ...patch,
            ...routing,
            updatedAt: new Date(),
          } as Service);
        } else {
          // Create new - new compose services default to enabled.
          const svc = await this.create({
            projectId,
            name: p.name,
            kind: "compose",
            ...toComposeSpec(p),
            ...routing,
            enabled: true,
            sortOrder: i,
          });
          results.push(svc);
        }
      }

      // Remove stale compose services (not in the incoming compose YAML).
      // Monorepo sub-apps live in a different kind and were filtered out
      // above; they survive untouched.
      if (removeMissing) {
        for (const ex of composeExisting) {
          if (!incomingNames.has(ex.name)) {
            await this.remove(ex.id);
          }
        }
      }

      return results;
    },

    /**
     * REDEPLOY reconciliation — 3-way merge of the freshly re-parsed repo compose
     * (`parsed` = "theirs") against each row's `importedSpec` ("base") and current
     * values ("ours"):
     *   • repo unchanged             → keep ours (clear any stale drift)
     *   • repo changed, not edited   → auto-apply theirs, advance baseline
     *   • repo changed, edited       → keep ours, set `driftSpec` (needs approval)
     *   • new upstream service       → create (baseline = theirs)
     *   • removed upstream, unedited → remove; edited/unknown baseline → keep
     * Baseline bootstrap: rows with null `importedSpec` (pre-feature, or just
     * imported by the wizard) adopt theirs as baseline on first reconcile WITHOUT
     * overwriting the user's values. Never touches routing, `enabled`, or
     * `sortOrder` (all user-owned).
     *
     * Unlike syncFromCompose, `parsed` here is the REPO's current compose, not a
     * UI/DB-derived payload — so it detects real upstream drift.
     */
    async reconcileFromCompose(projectId: string, parsed: ParsedComposeService[]) {
      const composeParsed = parsed.filter((p) => !p.kind || p.kind === "compose");
      const all = await this.listByProject(projectId);
      const composeExisting = all.filter((s) => s.kind === "compose" || s.kind === null);
      const existingByName = new Map(composeExisting.map((s) => [s.name, s]));
      const incomingNames = new Set(composeParsed.map((s) => s.name));
      const driftedNames: string[] = [];

      for (let i = 0; i < composeParsed.length; i++) {
        const p = composeParsed[i];
        const theirs = toComposeSpec(p);
        const ex = existingByName.get(p.name);

        // New upstream service → create with baseline = theirs.
        if (!ex) {
          const routing = normalizeRoutingFields({
            exposed: p.exposed ?? false,
            exposedPort: p.exposedPort,
            domain: p.domain,
            customDomain: p.customDomain,
            domainType: p.domainType,
          });
          await this.create({
            projectId,
            name: p.name,
            kind: "compose",
            ...theirs,
            ...routing,
            importedSpec: theirs,
            driftSpec: null,
            enabled: true,
            sortOrder: i,
          });
          continue;
        }

        const base = ex.importedSpec ?? null;
        const ours = toComposeSpec(ex);

        // Bootstrap: no baseline yet → adopt theirs as baseline, keep ours.
        // sortOrder is NEVER reset by reconcile — it's user-editable (dashboard
        // reordering) and the compose file has no ordering to authoritatively sync.
        if (base === null) {
          await this.update(ex.id, { importedSpec: theirs, driftSpec: null });
          continue;
        }

        // Repo unchanged → keep ours. Only write to clear a stale drift (repo
        // reverted to base); otherwise skip entirely so we don't churn updatedAt
        // on every deploy.
        if (composeSpecsEqual(theirs, base)) {
          if (ex.driftSpec) await this.update(ex.id, { driftSpec: null });
          continue;
        }

        // Repo changed, user has NOT edited → auto-apply theirs, advance baseline.
        if (composeSpecsEqual(ours, base)) {
          // Re-normalizing the row's OWN routing must round-trip it, exposed or
          // PAUSED. Omitting `publicEndpoints` dropped every secondary route on a
          // multi-route row (an app template's second port) on the next redeploy,
          // and an unexposed row lost its whole route config — the docstring's
          // "never touches routing" only held for single-route exposed rows.
          const routing = normalizeRoutingFields({
            exposed: ex.exposed,
            exposedPort: ex.exposedPort,
            domain: ex.domain,
            customDomain: ex.customDomain,
            domainType: ex.domainType,
            publicEndpoints: ex.publicEndpoints,
          });
          await this.update(ex.id, {
            ...theirs,
            ...routing,
            importedSpec: theirs,
            driftSpec: null,
          });
          continue;
        }

        // Repo changed AND user edited → protect ours, flag drift for approval.
        // Only write when the pending drift actually changes (avoid churn).
        if (!ex.driftSpec || !composeSpecsEqual(ex.driftSpec, theirs)) {
          await this.update(ex.id, { driftSpec: theirs });
        }
        driftedNames.push(p.name);
      }

      // Removed upstream: remove only if the user never edited it; otherwise keep.
      for (const ex of composeExisting) {
        if (incomingNames.has(ex.name)) continue;
        const base = ex.importedSpec ?? null;
        const unedited = base !== null && composeSpecsEqual(toComposeSpec(ex), base);
        if (unedited) await this.remove(ex.id);
      }

      const services = await this.listByProject(projectId);
      return { services, driftedNames };
    },

    // ── Service Deployments ────────────────────────────────────────────

    async findServiceDeployment(id: string) {
      return db.query.serviceDeployment.findFirst({
        where: eq(serviceDeployment.id, id),
      });
    },

    async listByDeployment(deploymentId: string) {
      return db.query.serviceDeployment.findMany({
        where: eq(serviceDeployment.deploymentId, deploymentId),
      });
    },

    /** service_deployment rows referencing any of these live container ids —
     *  the "are these containers already managed by a project here?" lookup that
     *  makes a re-import idempotent (refuse re-adopting an existing project's
     *  containers instead of minting a duplicate `-2` set). Callers resolve each
     *  row's deployment→project for org-scope + soft-delete checks. */
    async findByContainerIds(containerIds: string[]): Promise<ServiceDeployment[]> {
      if (containerIds.length === 0) return [];
      return db.query.serviceDeployment.findMany({
        where: inArray(serviceDeployment.containerId, containerIds),
      });
    },

    async listByService(serviceId: string) {
      return db.query.serviceDeployment.findMany({
        where: eq(serviceDeployment.serviceId, serviceId),
      });
    },

    async createServiceDeployment(data: Omit<NewServiceDeployment, "id">) {
      const id = generateId("sd");
      const row = { id, ...data };
      await db.insert(serviceDeployment).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as ServiceDeployment;
    },

    /**
     * Insert-or-update a service_deployment row keyed by (deploymentId,
     * serviceId) — respects the uq_service_deployment_dep_svc unique index.
     * Used by a partial (smart) redeploy to carry an unchanged service's
     * runtime row forward over the pre-created "skipped" row without
     * violating the unique constraint.
     */
    async upsertServiceDeployment(data: Omit<NewServiceDeployment, "id">) {
      const id = generateId("sd");
      await db
        .insert(serviceDeployment)
        .values({ id, ...data })
        .onConflictDoUpdate({
          target: [serviceDeployment.deploymentId, serviceDeployment.serviceId],
          set: {
            serviceName: data.serviceName,
            containerId: data.containerId ?? null,
            status: data.status,
            imageRef: data.imageRef ?? null,
            imageDigest: data.imageDigest ?? null,
            hostPort: data.hostPort ?? null,
            ip: data.ip ?? null,
            reason: data.reason ?? null,
            reasonSkipped: data.reasonSkipped ?? null,
            updatedAt: new Date(),
          },
        });
    },

    async updateServiceDeployment(id: string, data: Partial<NewServiceDeployment>) {
      await db
        .update(serviceDeployment)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(serviceDeployment.id, id));
    },
  };
}
