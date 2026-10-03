import { eq, and, asc, inArray, sql } from "drizzle-orm";
import {
  commandToArgv,
  generateId,
  mergeAdvanced,
  normalizeCustomHostname,
  resolveCommandArgv,
  resolveWorkload,
  type ComposeAdvanced,
  type ResourceValues,
} from "@repo/core";
import type { Database } from "../connection";
import { createConfigurationSecrets, type ConfigurationEncryption } from "../configuration-secrets";
import { deployment, envVar, project, service, serviceDeployment } from "../schema";
import type { ComposeServiceSpec, ServicePublicEndpoint } from "../schema/service";
import { liveBuildExecutionCondition } from "./deployment.repo";

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
  buildArgs?: Record<string, string | null> | null;
  ports?: string[] | null;
  dependsOn?: string[] | null;
  environment?: Record<string, string> | null;
  environmentTemplates?: Record<string, string> | null;
  volumes?: string[] | null;
  command?: string | null;
  commandArgv?: string[] | null;
  restart?: string | null;
  advanced?: ComposeAdvanced | null;
}): ComposeServiceSpec {
  const advanced: ComposeAdvanced = { ...(s.advanced ?? {}) };
  const environment = { ...(s.environment ?? {}) };
  if (s.environmentTemplates) {
    for (const [key, expression] of Object.entries(s.environmentTemplates)) {
      environment[key] = expression;
    }
    advanced.environmentTemplateKeys = Object.keys(s.environmentTemplates);
  }

  return {
    image: s.image ?? null,
    build: s.build ?? null,
    dockerfile: s.dockerfile ?? null,
    buildArgs: s.buildArgs ?? {},
    ports: s.ports ?? [],
    dependsOn: s.dependsOn ?? [],
    environment,
    volumes: s.volumes ?? [],
    command: s.command ?? null,
    // #332: derive argv from the text `command` when a row has no explicit
    // `commandArgv` (legacy rows stored before the fix). This keeps drift
    // comparison representation-stable — a legacy row and its re-parse
    // canonicalize identically instead of flagging a phantom string↔argv change.
    commandArgv: s.commandArgv ?? commandToArgv(s.command ?? null),
    restart: s.restart ?? "unless-stopped",
    advanced,
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

const composeValuesEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

/** Compose-field equality (ignores routing + ordering-insensitive env). */
export const composeSpecsEqual = (a: ComposeServiceSpec, b: ComposeServiceSpec) =>
  composeValuesEqual(toComposeSpec(a), toComposeSpec(b));

/** A raw source expression was replaced before inline edits had ownership
 * metadata. It may be an old interpolation result or an intentional edit. */
export function unresolvedComposeEnvironmentKeys(
  ours: Pick<Service, "environment" | "advanced">,
  source: ComposeServiceSpec,
): string[] {
  const overrides = new Set(ours.advanced?.environmentOverrideKeys ?? []);
  return (source.advanced?.environmentTemplateKeys ?? []).filter(
    (key) => !overrides.has(key) && ours.environment?.[key] !== source.environment?.[key],
  );
}

/** Merge each environment key independently. Repo omissions and unresolved
 * expressions cannot erase a saved value; those values become explicit
 * overrides. Known source expressions remain dynamic at deployment time. */
function reconcileComposeEnvironment(
  ours: ComposeServiceSpec,
  theirs: ComposeServiceSpec,
  base: ComposeServiceSpec | null,
  preview?: Pick<ParsedComposeService, "environment" | "environmentMeta">,
) {
  const environment = { ...(ours.environment ?? {}) };
  const templateKeys = new Set(ours.advanced?.environmentTemplateKeys ?? []);
  const overrideKeys = new Set(ours.advanced?.environmentOverrideKeys ?? []);
  const sourceTemplates = new Set(theirs.advanced?.environmentTemplateKeys ?? []);
  const keys = new Set([
    ...Object.keys(environment),
    ...Object.keys(base?.environment ?? {}),
    ...Object.keys(theirs.environment ?? {}),
  ]);
  for (const key of keys) {
    if (overrideKeys.has(key)) {
      if (!Object.hasOwn(environment, key)) templateKeys.delete(key);
      continue;
    }
    const value = environment[key];
    const next = theirs.environment?.[key];
    const hasValue = Object.hasOwn(environment, key);
    const hasSource = Object.hasOwn(theirs.environment ?? {}, key);
    const knownTemplate =
      templateKeys.has(key) &&
      ((base?.advanced?.environmentTemplateKeys?.includes(key) &&
        value === base.environment?.[key]) ||
        (sourceTemplates.has(key) && value === next));
    const sourceOwned =
      base === null
        ? !hasValue ||
          value === next ||
          (sourceTemplates.has(key) && value === preview?.environment?.[key])
        : value === base.environment?.[key] &&
          hasValue === Object.hasOwn(base.environment ?? {}, key);
    // A legacy literal can be the only durable copy of a credential. Restore
    // its expression only when the scan actually resolved it, or when the live
    // value is that same incomplete preview (so no working value is lost).
    const losesSavedValue =
      Boolean(value) &&
      !knownTemplate &&
      (next === "" ||
        (sourceTemplates.has(key) &&
          value !== next &&
          value !== preview?.environment?.[key] &&
          (!preview?.environment?.[key] || preview.environmentMeta?.[key]?.required)));
    if (!hasSource || !sourceOwned || losesSavedValue) {
      overrideKeys.add(key);
      if (!knownTemplate) templateKeys.delete(key);
    } else {
      environment[key] = next!;
      if (sourceTemplates.has(key)) templateKeys.add(key);
      else templateKeys.delete(key);
    }
  }
  return {
    environment,
    advanced: mergeAdvanced(ours.advanced ?? null, {
      ...(Object.hasOwn(ours.advanced ?? {}, "environmentTemplateKeys") ||
      Object.hasOwn(theirs.advanced ?? {}, "environmentTemplateKeys")
        ? { environmentTemplateKeys: [...templateKeys].sort() }
        : {}),
      ...(overrideKeys.size ? { environmentOverrideKeys: [...overrideKeys].sort() } : {}),
    }),
  };
}

/** Three-way merge maps by key; arrays and scalars are indivisible fields.
 * Local changes win only where they were made, including explicit deletions. */
function mergeComposeValue(ours: unknown, base: unknown, theirs: unknown): unknown {
  if (composeValuesEqual(ours, base)) return theirs;
  const isMap = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (isMap(ours) && isMap(base) && isMap(theirs)) {
    return Object.fromEntries(
      [...new Set([...Object.keys(ours), ...Object.keys(base), ...Object.keys(theirs)])]
        .map((key) => [key, mergeComposeValue(ours[key], base[key], theirs[key])] as const)
        .filter(([, value]) => value !== undefined),
    );
  }
  return ours;
}

/** The same non-destructive source merge is used by redeploy and by the legacy
 * Accept Compose endpoint. Environment deletion belongs to the env editor. */
export function reconcileComposeSpec(
  oursInput: ComposeServiceSpec,
  baseInput: ComposeServiceSpec | null,
  nextInput: ComposeServiceSpec,
  preview?: Pick<ParsedComposeService, "environment" | "environmentMeta">,
  options: { acceptUpstream?: boolean } = {},
): ComposeServiceSpec {
  const ours = toComposeSpec(oursInput);
  const base = baseInput === null ? null : toComposeSpec(baseInput);
  const theirs = toComposeSpec(nextInput);
  const restored = reconcileComposeEnvironment(ours, theirs, base, preview);
  const merged = options.acceptUpstream
    ? { ...theirs }
    : base === null
      ? { ...ours }
      : (mergeComposeValue(ours, base, theirs) as ComposeServiceSpec);
  if (options.acceptUpstream) {
    merged.advanced = { ...ours.advanced, ...theirs.advanced };
    for (const key of Object.keys(base?.advanced ?? {}) as Array<keyof ComposeAdvanced>) {
      if (!Object.hasOwn(theirs.advanced ?? {}, key)) delete merged.advanced[key];
    }
  }

  // Old imports have no comparison baseline. Retain their adopted image and
  // other runtime settings while initializing newly supported build args.
  if (base === null && !options.acceptUpstream) {
    merged.buildArgs = { ...theirs.buildArgs, ...ours.buildArgs };
  }
  const imageFromSource =
    options.acceptUpstream ||
    (base === null
      ? Boolean(theirs.advanced?.imageTemplate) &&
        (Boolean(ours.advanced?.imageTemplate) ||
          ours.image === theirs.advanced?.imageTemplate?.sourceValue)
      : ours.image === base.image &&
        (!base.advanced?.imageTemplate ||
          composeValuesEqual(ours.advanced?.imageTemplate, base.advanced.imageTemplate)));
  if (!imageFromSource) merged.image = ours.image;

  // command and argv are two representations of one field, and provenance
  // always travels with the value it describes.
  if (
    !options.acceptUpstream &&
    base &&
    (!composeValuesEqual(ours.command, base.command) ||
      !composeValuesEqual(ours.commandArgv, base.commandArgv))
  ) {
    merged.command = ours.command;
    merged.commandArgv = ours.commandArgv;
  }
  const buildArgFromSource = (key: string) =>
    options.acceptUpstream ||
    (base === null
      ? !Object.hasOwn(ours.buildArgs ?? {}, key)
      : composeValuesEqual(ours.buildArgs?.[key], base.buildArgs?.[key]) &&
        !(
          base.advanced?.buildArgTemplateKeys?.includes(key) &&
          !ours.advanced?.buildArgTemplateKeys?.includes(key)
        ));
  merged.buildArgs = { ...merged.buildArgs };
  for (const [key, value] of Object.entries(ours.buildArgs ?? {})) {
    if (!buildArgFromSource(key)) merged.buildArgs[key] = value;
  }
  const buildArgTemplateKeys = Object.keys(merged.buildArgs ?? {}).filter((key) =>
    (buildArgFromSource(key) ? theirs : ours).advanced?.buildArgTemplateKeys?.includes(key),
  );
  merged.environment = restored.environment;
  merged.advanced = mergeAdvanced(merged.advanced, {
    imageTemplate: (imageFromSource ? theirs : ours).advanced?.imageTemplate ?? null,
    environmentTemplateKeys: restored.advanced.environmentTemplateKeys ?? null,
    environmentOverrideKeys: restored.advanced.environmentOverrideKeys ?? null,
    buildArgTemplateKeys:
      Object.hasOwn(theirs.advanced ?? {}, "buildArgTemplateKeys") ||
      Object.hasOwn(ours.advanced ?? {}, "buildArgTemplateKeys")
        ? buildArgTemplateKeys
        : null,
  });
  return merged;
}

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
 * reconcileFromCompose instead uses the baseline-aware merge above, which
 * tracks ownership separately for each field and preserves saved environment.
 */
export function composeWritePatch(
  parsed: ParsedComposeService,
  stored?: {
    image?: string | null;
    advanced?: ComposeAdvanced | null;
    buildArgs?: Record<string, string | null> | null;
    command?: string | null;
    commandArgv?: string[] | null;
  } | null,
  /** `parsed` is a full re-read of the compose FILE, so an absent compose-owned
   *  key means the author deleted it. See {@link COMPOSE_OWNED_ADVANCED_KEYS}. */
  composeAuthoritative = false,
): ComposeServiceSpec & { advanced: ComposeAdvanced } {
  // Raw parser rows name their template keys. Every other writer (manual API,
  // CLI-normalized config, old snapshot) means its supplied values literally;
  // stamp that fact so a stale stored marker cannot reinterpret a later edit.
  const hasBuildArgMarker = Object.hasOwn(parsed.advanced ?? {}, "buildArgTemplateKeys");
  const suppliedBuildArgCount = Object.keys(parsed.buildArgs ?? {}).length;
  const parsedAdvanced =
    parsed.buildArgs !== undefined && suppliedBuildArgCount > 0 && !hasBuildArgMarker
      ? { ...(parsed.advanced ?? {}), buildArgTemplateKeys: [] }
      : parsed.advanced;
  const hasImageTemplateMarker = Object.hasOwn(parsed.advanced ?? {}, "imageTemplate");
  const usesLiteralImage = parsed.image !== undefined && !hasImageTemplateMarker;
  const spec = toComposeSpec({ ...parsed, advanced: parsedAdvanced });
  // An explicit reset discards the stored blob, while retaining provenance
  // supplied by this incoming parse. Omission still preserves operator fields.
  const advanced = mergeAdvanced(
    parsed.advanced === null ? null : (stored?.advanced ?? null),
    spec.advanced,
  );
  if (usesLiteralImage) {
    // A writer that supplies an image without parser provenance means that
    // image literally. This includes manual edits AND old frozen snapshots;
    // inheriting the current row's expression would make either one deploy a
    // different artifact than it requested.
    delete advanced.imageTemplate;
  }
  // An explicit empty map clears build args and any stale template provenance,
  // but should not add metadata to an otherwise byte-for-byte snapshot replay.
  if (parsed.buildArgs !== undefined && suppliedBuildArgCount === 0 && !hasBuildArgMarker) {
    delete advanced.buildArgTemplateKeys;
  }
  // A deploy/rollback can replay a snapshot produced before buildArgs existed.
  // Its omission means "this writer has no opinion", not "delete every arg".
  // A fresh authoritative compose parse is different: an absent args block is a
  // real deletion and must clear the stored map. The provenance marker is also
  // an explicit opinion: a current `build:` declaration with no args has no
  // buildArgs values to carry, but the parser emits `buildArgTemplateKeys: []`
  // so this path can distinguish it from a legacy snapshot that never modeled
  // build args at all.
  const hasBuildArgsOpinion = parsed.buildArgs !== undefined || hasBuildArgMarker;
  const buildArgs =
    composeAuthoritative || hasBuildArgsOpinion
      ? spec.buildArgs
      : ((stored?.buildArgs as Record<string, string | null> | null) ?? {});
  // #332: several wire shapes into this path carry `command` as a STRING only
  // (BuildServiceInput on the deploy request, the sync endpoint), and the stored
  // string is a lossy display join for a list command. toComposeSpec's fallback
  // would re-split it — turning a correct `["sh","-c","a && b"]` into five words on
  // the next deploy. An unchanged string therefore keeps the stored argv; only a
  // real change re-derives. See resolveCommandArgv.
  const commandArgv = resolveCommandArgv({
    incomingArgv: parsed.commandArgv,
    incomingCommand: parsed.command ?? null,
    storedCommand: stored?.command,
    storedArgv: stored?.commandArgv,
  });
  return {
    ...spec,
    buildArgs,
    ...(commandArgv !== undefined ? { commandArgv } : {}),
    advanced: composeAuthoritative ? clearComposeOwnedKeys(advanced, spec.advanced) : advanced,
  };
}

/**
 * `advanced` keys that compose YAML can express, and therefore OWNS.
 *
 * The merge above exists for keys compose has no syntax for — a readiness gate,
 * generated config files, an east-west alias — where an absent key means "the
 * parser had nothing to say", not "the operator removed it". Shared namespaces
 * are the opposite: nothing but the compose file sets them, so an absent key
 * means DELETED, and merging would keep pinning the container into a namespace
 * the file no longer asks for (or into a service that no longer exists, which
 * the deploy then refuses). `entrypoint` (#575) is owned for the same reason —
 * dropping `entrypoint:` from the file has to hand the image's own ENTRYPOINT
 * back, not keep running last week's override.
 *
 * Note this sweep tests for `undefined`, not falsiness, which is what lets
 * `entrypoint: []` — compose's "clear the image ENTRYPOINT" — survive it. A
 * truthiness test here would silently reinstate the wrapper it exists to remove.
 *
 * Only honored when the caller says its input IS the file. Half of
 * syncFromCompose's callers pass a release's frozen snapshot rather than a fresh
 * parse — and that snapshot travels through a wire schema with no `advanced` at
 * all (BuildServiceInput), so treating its silence as a deletion would wipe the
 * namespace on the next deploy. Removal on the git path already propagates the
 * right way, through `reconcileFromCompose` applying `theirs` wholesale.
 */
const COMPOSE_OWNED_ADVANCED_KEYS = [
  "networkMode",
  "pidMode",
  "entrypoint",
  "imageTemplate",
  "environmentTemplateKeys",
  "environmentOverrideKeys",
  "buildArgTemplateKeys",
] as const;

function clearComposeOwnedKeys(
  merged: ComposeAdvanced,
  parsed: ComposeAdvanced | undefined,
): ComposeAdvanced {
  const out = { ...merged };
  for (const key of COMPOSE_OWNED_ADVANCED_KEYS) {
    if (parsed?.[key] === undefined) delete out[key];
  }
  return out;
}

/** Per-field diff of two specs — powers the drift UI. */
export function composeSpecDiff(base: ComposeServiceSpec, next: ComposeServiceSpec) {
  const fields: (keyof ComposeServiceSpec)[] = [
    "image",
    "build",
    "dockerfile",
    "buildArgs",
    "ports",
    "dependsOn",
    "environment",
    "volumes",
    "command",
    "commandArgv",
    "restart",
    "advanced",
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
  buildArgs?: Record<string, string | null>;
  ports?: string[];
  dependsOn?: string[];
  environment?: Record<string, string>;
  environmentTemplates?: Record<string, string>;
  environmentMeta?: Record<string, { required?: boolean }>;
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
    const customDomain =
      domainType === "custom"
        ? normalizeCustomHostname(endpoint.customDomain ?? "") || undefined
        : undefined;
    if (domainType === "free" && !domain) continue;
    if (domainType === "custom" && !customDomain) continue;
    seenPorts.add(port);
    out.push({
      port,
      domainType,
      ...(domain ? { domain } : {}),
      ...(customDomain ? { customDomain } : {}),
    });
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
      domain: primary.domainType === "free" ? (primary.domain ?? null) : null,
      customDomain: primary.domainType === "custom" ? (primary.customDomain ?? null) : null,
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
    customDomain:
      domainType === "custom" ? normalizeCustomHostname(input.customDomain ?? "") || null : null,
    domainType,
    publicEndpoints: [],
  };
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServiceRepo(db: Database, encryption: ConfigurationEncryption) {
  const codec = createConfigurationSecrets(encryption);

  function writeUpdate(id: string, data: Partial<NewService>, updatedAt: Date | null = new Date()) {
    return db
      .update(service)
      .set(codec.sealService({ ...data, ...(updatedAt === null ? {} : { updatedAt }) }))
      .where(eq(service.id, id));
  }

  /** Both Compose writers compare decrypted values before sealing the patch.
   * No-op syncs and import metadata must not mark unchanged containers dirty
   * (#986). Every changed configuration field still requires a deployment. */
  async function updateFromCompose(stored: Service, data: Partial<NewService>): Promise<Service> {
    const changed = Object.entries(data).filter(
      ([key, value]) => value !== undefined && !composeValuesEqual(stored[key as keyof Service], value),
    );
    if (changed.length === 0) return stored;

    const patch = Object.fromEntries(changed) as Partial<NewService>;
    const configChanged = changed.some(([key]) => key !== "importedSpec" && key !== "driftSpec");
    // Omit the timestamp on metadata-only writes: setting the value we read
    // could backdate a concurrent config edit. RETURNING includes those edits
    // in the result instead of echoing a stale read over the persisted row.
    const [updated] = await writeUpdate(stored.id, patch, configChanged ? new Date() : null).returning();
    if (!updated) throw new Error("Service was removed during Compose synchronization");
    return codec.openService(updated);
  }

  return {
    // ── Services ───────────────────────────────────────────────────────

    async findById(id: string) {
      return codec.openService(await db.query.service.findFirst({
        where: eq(service.id, id),
      }));
    },

    /** Batch id → display name, for naming services in list responses. */
    async listNamesByIds(ids: string[]): Promise<{ id: string; name: string }[]> {
      if (ids.length === 0) return [];
      return db
        .select({ id: service.id, name: service.name })
        .from(service)
        .where(inArray(service.id, ids));
    },

    async findByName(projectId: string, name: string) {
      return codec.openService(await db.query.service.findFirst({
        where: and(eq(service.projectId, projectId), eq(service.name, name)),
      }));
    },

    async listByProject(projectId: string) {
      return (await db.query.service.findMany({
        where: eq(service.projectId, projectId),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      })).map(codec.openService);
    },

    /** Draft definitions do not consume running-service slots. Once a project
     * has an active deployment, enabled definitions reserve a slot for starts
     * and restarts. Disabling cannot release a slot while its active deployment
     * still runs the container. Queued deployments reserve their frozen names.
     * Compose containers share a VM, so provider workspace count cannot enforce
     * this application allowance. Exclusions support atomic enable/re-enable. */
    async countRunningForOrg(
      organizationId: string,
      excludingServiceIds: readonly string[] = [],
      excludingNativeProjectId?: string,
      prospective?: { projectId: string; serviceNames: readonly string[] },
      workspaceId?: string | null,
    ): Promise<number> {
      // Read one snapshot: deployment completion can otherwise land between
      // reading definitions and queued reservations, briefly losing both.
      return db.transaction(
        async (tx) => {
          const definitions = await tx
            .select({
              id: service.id,
              projectId: service.projectId,
              name: service.name,
              reserved: sql<boolean>`(
                (${service.enabled} = true AND ${project.activeDeploymentId} IS NOT NULL)
                OR EXISTS (
                  SELECT 1 FROM ${serviceDeployment}
                  WHERE ${serviceDeployment.serviceId} = ${service.id}
                    AND ${serviceDeployment.deploymentId} = ${project.activeDeploymentId}
                    AND ${serviceDeployment.containerId} IS NOT NULL
                    AND ${serviceDeployment.status} <> 'stopped'
                )
              )`,
            })
            .from(service)
            .innerJoin(project, eq(service.projectId, project.id))
            .where(
              and(eq(project.organizationId, organizationId), sql`${project.deletedAt} IS NULL`, projectWorkspaceScope(workspaceId)),
            );
          const excluded = new Set(excludingServiceIds);
          const slots = new Set(
            definitions.filter((row) => row.reserved && !excluded.has(row.id)).map((row) => row.id),
          );
          const byName = new Map<string, typeof definitions>();
          const key = (projectId: string, name: string) => JSON.stringify([projectId, name]);
          for (const row of definitions) {
            const identity = key(row.projectId, row.name);
            byName.set(identity, [...(byName.get(identity) ?? []), row]);
          }
          const reserve = (projectId: string, names: readonly string[]) => {
            for (const name of names) {
              const identity = key(projectId, name);
              const saved = byName.get(identity);
              if (saved) {
                for (const row of saved) if (!excluded.has(row.id)) slots.add(row.id);
              } else slots.add(`pending:${identity}`);
            }
          };
          // A frozen/imported stack can be queued before sync creates its service
          // rows. Reserve those names immediately and deduplicate them once saved.
          // Keep the reservation through activation/cancellation until the worker
          // acknowledges completion, using the same lease as project teardown.
          const pending = sql`(${deployment.status} IN ('queued', 'building', 'deploying', 'reconciling')
            OR ${liveBuildExecutionCondition()})`;
          const queued = await tx
            .select({
              projectId: deployment.projectId,
              names: sql<unknown>`${deployment.meta}->'cloudServiceSlots'`,
            })
            .from(deployment)
            .innerJoin(project, eq(deployment.projectId, project.id))
            .where(
              and(
                eq(project.organizationId, organizationId),
                sql`${project.deletedAt} IS NULL`,
                pending,
                sql`${deployment.meta}->'cloudServiceSlots' IS NOT NULL`,
                projectWorkspaceScope(workspaceId),
              ),
            );
          for (const row of queued) {
            if (
              !Array.isArray(row.names) ||
              row.names.some((name) => typeof name !== "string" || !name)
            )
              throw new Error("The deployment's Cloud service reservation is invalid");
            reserve(row.projectId, row.names);
          }
          if (prospective) reserve(prospective.projectId, prospective.serviceNames);
          // A single-app deployment has no service row. Queued deployments reserve
          // its slot under the same organization lock as service creation, while an
          // active deployment keeps the slot until the project is paused/deleted.
          // Count a project once during redeploy, even with two deployment records.
          const native = await tx
            .select({ projectId: project.id, meta: deployment.meta })
            .from(deployment)
            .innerJoin(project, eq(deployment.projectId, project.id))
            .where(
              and(
                eq(project.organizationId, organizationId),
                sql`${project.deletedAt} IS NULL`,
                excludingNativeProjectId
                  ? sql`${project.id} <> ${excludingNativeProjectId}`
                  : undefined,
                projectWorkspaceScope(workspaceId),
                sql`(
                  (${pending}
                    AND ${deployment.meta}->>'cloudApplicationSlot' = 'true')
                  OR (${deployment.id} = ${project.activeDeploymentId}
                    AND ${project.disabledAt} IS NULL AND ${deployment.containerId} IS NOT NULL
                    AND (${deployment.meta}->>'cloudApplicationSlot' = 'true'
                      OR (${deployment.meta}->>'cloudApplicationSlot' IS NULL
                        AND (${deployment.meta}->>'serviceDeploymentMode' = 'single' OR NOT EXISTS (
                          SELECT 1 FROM ${serviceDeployment} WHERE ${serviceDeployment.deploymentId} = ${deployment.id}
                        )))))
                )`,
              ),
            );
          const nativeProjects = new Set(
            native
              .filter((item) => {
                const snapshot = (item.meta ?? {}) as { workload?: string; hasServer?: boolean };
                return resolveWorkload(snapshot.workload, snapshot.hasServer) !== "static";
              })
              .map((item) => item.projectId),
          );
          return slots.size + nativeProjects.size;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    /**
     * Batch variant of listByProject — one SQL round trip for N
     * projects. Used by getHome to eliminate the N+1.
     */
    async listByProjects(projectIds: string[]): Promise<Map<string, Service[]>> {
      if (projectIds.length === 0) return new Map();
      const rows = (await db.query.service.findMany({
        where: inArray(service.projectId, projectIds),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      })).map(codec.openService);
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
      // Return the persisted defaults and timestamps. Synthesizing a Service
      // from the input omitted fields such as namespaceVolumes and made create
      // disagree with the next read of the same row.
      const [row] = await db.insert(service).values(codec.sealService({ id, ...data })).returning();
      return codec.openService(row!);
    },

    async update(id: string, data: Partial<NewService>) {
      await writeUpdate(id, data);
    },

    /** Apply a catalog's initial profiles to an unfinished app as one write set.
     * Lock the project and services before decrypting/merging configuration so
     * existing resource settings and concurrent edits cannot be overwritten. */
    async seedDraftAppResourceDefaults(input: {
      projectId: string;
      organizationId: string;
      appTemplateId: string;
      profiles: readonly { name: string; resources: Readonly<ResourceValues> }[];
    }): Promise<string[]> {
      if (input.profiles.length === 0) return [];
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: project.id })
          .from(project)
          .where(
            and(
              eq(project.id, input.projectId),
              eq(project.organizationId, input.organizationId),
              eq(project.appTemplateId, input.appTemplateId),
              sql`${project.resources} IS NULL`,
              sql`${project.activeDeploymentId} IS NULL`,
              sql`${project.deletedAt} IS NULL`,
              eq(project.deletionInProgress, false),
            ),
          )
          .for("update");
        if (!owner) return [];
        const rows = await tx
          .select()
          .from(service)
          .where(
            and(
              eq(service.projectId, owner.id),
              inArray(
                service.name,
                input.profiles.map((profile) => profile.name),
              ),
            ),
          )
          .orderBy(asc(service.id))
          .for("update");
        const byName = new Map(rows.map((row) => [row.name, codec.openService(row)]));
        const changed: string[] = [];
        for (const profile of input.profiles) {
          const row = byName.get(profile.name);
          if (!row || row.advanced?.resources != null) continue;
          await tx
            .update(service)
            .set(
              codec.sealService({
                advanced: { ...row.advanced, resources: { ...profile.resources } },
                updatedAt: new Date(),
              }),
            )
            .where(and(eq(service.id, row.id), eq(service.projectId, owner.id)));
          changed.push(row.id);
        }
        return changed;
      });
    },

    async remove(id: string) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select({ projectId: service.projectId }).from(service).where(eq(service.id, id));
        if (row) {
          const [owner] = await tx.select({ compositeRoutes: project.compositeRoutes })
            .from(project).where(eq(project.id, row.projectId)).for("update");
          const routes = owner?.compositeRoutes ?? [];
          if (routes.some((route) => route.rootServiceId === id || route.locations.some((location) => location.serviceId === id))) {
            await tx.update(project).set({
              compositeRoutes: routes.filter((route) => route.rootServiceId !== id).map((route) => ({
                ...route, locations: route.locations.filter((location) => location.serviceId !== id),
              })),
              updatedAt: new Date(),
            }).where(eq(project.id, row.projectId));
          }
        }
        await tx.delete(service).where(eq(service.id, id));
      });
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
      return (await db.query.service.findMany({
        where: and(eq(service.projectId, projectId), eq(service.kind, kind)),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      })).map(codec.openService);
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
          exposedPort:
            app.exposedPort ?? ex?.exposedPort ?? (app.port != null ? String(app.port) : null),
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
      opts?: { removeMissing?: boolean; composeAuthoritative?: boolean },
    ) {
      const removeMissing = opts?.removeMissing ?? true;
      // Default false: only a caller that just re-read the compose file may treat
      // an absent compose-owned key as a deletion (see COMPOSE_OWNED_ADVANCED_KEYS).
      // That same authoritative read establishes/advances the 3-way-merge
      // baseline. Without it, an image edited immediately after import is
      // indistinguishable from a stale scan value during the first deployment.
      const composeAuthoritative = opts?.composeAuthoritative ?? false;
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
          const patch = composeWritePatch(p, ex, composeAuthoritative);
          results.push(
            await updateFromCompose(ex, {
              ...patch,
              ...routing,
              ...(composeAuthoritative ? { importedSpec: toComposeSpec(p), driftSpec: null } : {}),
              // enabled + sortOrder left as-is (already on ex)
            }),
          );
        } else {
          const importedSpec = composeAuthoritative ? toComposeSpec(p) : undefined;
          // Create new - new compose services default to enabled.
          const svc = await this.create({
            projectId,
            name: p.name,
            kind: "compose",
            ...toComposeSpec(p),
            ...routing,
            ...(importedSpec ? { importedSpec } : {}),
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
     *   • repo omits env keys        → retain saved values as local overrides
     *   • repo changed, edited       → keep edited fields, update the others
     *   • new upstream service       → create (baseline = theirs)
     *   • removed upstream, unedited → remove only if no environment is saved
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
      const unresolvedEnvironment: Array<{ name: string; keys: string[] }> = [];

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

        const merged = reconcileComposeSpec(ours, base, theirs, p);
        await updateFromCompose(ex, {
          ...merged,
          ...normalizeRoutingFields({
            exposed: ex.exposed,
            exposedPort: ex.exposedPort,
            domain: ex.domain,
            customDomain: ex.customDomain,
            domainType: ex.domainType,
            publicEndpoints: ex.publicEndpoints,
          }),
          importedSpec: theirs,
          driftSpec: null,
        });
      }

      // An env_var row is an operator edit too. Removing a service cascades to
      // its environment, so source omission alone cannot delete saved values.
      for (const ex of composeExisting) {
        if (incomingNames.has(ex.name)) continue;
        const base = ex.importedSpec ?? null;
        const unedited = base !== null && composeSpecsEqual(toComposeSpec(ex), base);
        if (unedited && Object.keys(ex.environment ?? {}).length === 0) {
          const configured = await db.query.envVar.findFirst({
            where: eq(envVar.serviceId, ex.id),
            columns: { id: true },
          });
          if (!configured) await this.remove(ex.id);
        }
      }

      const services = await this.listByProject(projectId);
      return { services, driftedNames, unresolvedEnvironment };
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

    /**
     * Insert-or-update a service_deployment row keyed by (deploymentId,
     * serviceId) — respects the uq_service_deployment_dep_svc unique index.
     *
     * This is the ONLY way to record a service's runtime outcome, and the plain-insert
     * sibling that used to sit here is deliberately gone: a deploy has two writers for
     * this pair (a scoped deploy pre-creates a `skipped` row for every service it did not
     * target — service-checks.ts — and the compose loop writes the ones it deployed), so a
     * row very often already exists by the time an outcome is known. Inserting there raised
     * a unique violation that killed the deploy on its own bookkeeping, twice (#585).
     *
     * FULL-ROW writer: every column in the `set` below is assigned, so a caller must pass
     * the complete runtime picture. To patch a column or two, use `updateServiceDeployment`
     * — calling this with a partial payload NULLS the rest, which is how a carried `:latest`
     * service lost the `image_digest` the update scanner reads.
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
            allocatedResources: data.allocatedResources ?? null,
            status: data.status,
            imageRef: data.imageRef ?? null,
            imageDigest: data.imageDigest ?? null,
            hostPort: data.hostPort ?? null,
            hostPorts: data.hostPorts ?? null,
            ip: data.ip ?? null,
            reason: data.reason ?? null,
            reasonSkipped: data.reasonSkipped ?? null,
            updatedAt: new Date(),
          },
        });
    },

    /**
     * Record that a service FAILED in this deployment, whether or not a row for it
     * already exists.
     *
     * Why this exists next to `upsertServiceDeployment` rather than reusing it: a
     * smart/partial redeploy pre-creates a `skipped` row for every service it did not
     * target (service-checks.ts), and that row carries the LIVE runtime details of a
     * container that is still running — `containerId`, `imageDigest`, `hostPort`,
     * `hostPorts`, `ip`.
     * `upsertServiceDeployment` coalesces all of those to null, so using it here would
     * erase the record of a running container just because a *different* service
     * failed. Using a plain insert instead is what violated
     * `uq_service_deployment_dep_svc` and killed the deploy on its own bookkeeping.
     *
     * So the `set` below lists ONLY the failure facts. Drizzle updates just the listed
     * columns, so every runtime field is preserved by OMISSION — that is the load-bearing
     * detail, and the reason not to "simplify" this into the sibling method.
     *
     * `imageRef` is overwritten only when one is actually known: several call sites fail
     * before an image is resolved, and passing null there must not blank the image the
     * carried-forward row recorded.
     */
    async markServiceDeploymentFailed(data: {
      deploymentId: string;
      serviceId: string;
      serviceName: string;
      /** Defaults to "failure". Present so a caller can record e.g. "cancelled". */
      status?: string;
      imageRef?: string | null;
      /** Operator-facing reason. Persisted so it outlives the deploy's SSE session. */
      errorMessage?: string | null;
      reason?: string | null;
    }) {
      const now = new Date();
      const status = data.status ?? "failure";

      const set: Partial<NewServiceDeployment> = {
        serviceName: data.serviceName,
        status,
        finishedAt: now,
        updatedAt: now,
      };
      if (data.errorMessage !== undefined) set.errorMessage = data.errorMessage;
      if (data.reason !== undefined) set.reason = data.reason;
      if (data.imageRef) set.imageRef = data.imageRef;

      await db
        .insert(serviceDeployment)
        .values({
          id: generateId("sd"),
          deploymentId: data.deploymentId,
          serviceId: data.serviceId,
          serviceName: data.serviceName,
          status,
          imageRef: data.imageRef ?? null,
          errorMessage: data.errorMessage ?? null,
          reason: data.reason ?? null,
          finishedAt: now,
        })
        .onConflictDoUpdate({
          target: [serviceDeployment.deploymentId, serviceDeployment.serviceId],
          set,
        });
    },

    /**
     * Record that a service was SKIPPED in this deployment, whether or not a row for it
     * already exists.
     *
     * Same discipline — and the same reason for existing — as
     * `markServiceDeploymentFailed` above: the row this collides with is very often the
     * `skipped` row a smart/partial deploy pre-created (service-checks.ts), or one
     * carrying the LIVE runtime details of a container that is still running. The `set`
     * below therefore lists ONLY the skip facts, so `containerId` / `imageRef` /
     * `imageDigest` / `hostPort` / `hostPorts` / `ip` survive by OMISSION. That is the
     * load-bearing detail, and the reason this cannot be `upsertServiceDeployment` (a
     * full-row writer that coalesces every one of those to null).
     */
    async markServiceDeploymentSkipped(data: {
      deploymentId: string;
      serviceId: string;
      serviceName: string;
      /** Why it was skipped — see the `reason` docblock on the schema for the vocabulary. */
      reason: string;
    }) {
      await db
        .insert(serviceDeployment)
        .values({
          id: generateId("sd"),
          deploymentId: data.deploymentId,
          serviceId: data.serviceId,
          serviceName: data.serviceName,
          status: "skipped",
          reason: data.reason,
          reasonSkipped: data.reason,
        })
        .onConflictDoUpdate({
          target: [serviceDeployment.deploymentId, serviceDeployment.serviceId],
          set: {
            serviceName: data.serviceName,
            status: "skipped",
            reason: data.reason,
            reasonSkipped: data.reason,
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

    /** Commit a runtime-only env apply without creating a release/build session.
     * Keep the historical image/env capture; update only the live identity and
     * a per-service drift cutoff. The adapter retains the original container
     * until this transaction commits, and restores it if this write fails. */
    async recordEnvironmentApply(input: {
      projectId: string;
      organizationId: string;
      deploymentId: string;
      serviceId: string;
      expectedContainerId: string | null;
      previousContainerId: string;
      containerId: string;
      ip?: string;
      appliedAt: Date;
    }) {
      await db.transaction(async tx => {
        const [parent] = await tx.select().from(deployment).where(and(
          eq(deployment.id, input.deploymentId),
          eq(deployment.projectId, input.projectId),
          eq(deployment.organizationId, input.organizationId),
        )).for("update");
        const [row] = await tx.select().from(serviceDeployment).where(and(
          eq(serviceDeployment.deploymentId, input.deploymentId),
          eq(serviceDeployment.serviceId, input.serviceId),
        )).for("update");
        if (!parent || !row || row.containerId !== input.expectedContainerId) {
          throw new Error("The service changed while its environment was being applied. Try again.");
        }
        const now = new Date();
        await tx.update(serviceDeployment).set({
          containerId: input.containerId,
          ...(input.ip ? { ip: input.ip } : {}),
          allocatedResources: row.allocatedResources
            ? { ...row.allocatedResources, containerId: input.containerId }
            : null,
          status: "success",
          error: null,
          errorMessage: null,
          updatedAt: now,
        }).where(eq(serviceDeployment.id, row.id));

        // These fields contain IDs/times only. Preserve the stored (sealed)
        // configuration verbatim; do not decrypt/reseal a historical snapshot.
        const meta = (parent.meta ?? {}) as Record<string, unknown>;
        const oldIds = new Set([input.expectedContainerId, input.previousContainerId]);
        const composeServices = Array.isArray(meta.composeServices)
          ? meta.composeServices.map((item: Record<string, unknown>) =>
              item.name === row.serviceName
                ? { ...item, containerId: input.containerId, ...(input.ip ? { ip: input.ip } : {}) }
                : item)
          : undefined;
        await tx.update(deployment).set({
          ...(parent.containerId && oldIds.has(parent.containerId) ? { containerId: input.containerId } : {}),
          meta: {
            ...meta,
            ...(composeServices ? { composeServices } : {}),
            serviceEnvironmentApplied: {
              ...((meta.serviceEnvironmentApplied ?? {}) as Record<string, unknown>),
              [input.serviceId]: { containerId: input.containerId, appliedAt: input.appliedAt.toISOString() },
            },
          },
          updatedAt: now,
        }).where(eq(deployment.id, input.deploymentId));
      });
    },
  };
}
import { projectWorkspaceScope } from "./workspace-scope";
