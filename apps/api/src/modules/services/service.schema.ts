/**
 * Service validation schemas.
 *
 * Both compose services AND monorepo sub-apps share the `service` table
 * (discriminated by `kind`). These validators model that union - the
 * compose-only fields (image, build, dockerfile, ports, etc.) and the
 * monorepo-only build settings (installCommand, framework, ...) appear
 * together, optional on both sides, with `kind` flagging which shape is
 * load-bearing for a given row.
 *
 * The monorepo block is the SAME shared schema used by project create's
 * `monorepoApps[]` array - see `MonorepoSubAppFieldsSchema` in
 * project.schema.ts. Updating one updates both, eliminating the maxLength
 * / framework-enum drift the earlier audit flagged.
 */

import { Type, type Static } from "@sinclair/typebox";
import { EnvironmentScopeSchema } from "../../lib/environment-scope";
import { MonorepoSubAppFieldsSchema } from "../projects/project.schema";

export const ServiceIdParam = Type.Object({
  id: Type.String({ minLength: 1 }),
  serviceId: Type.String({ minLength: 1 }),
});

export const ProjectIdParam = Type.Object({
  id: Type.String({ minLength: 1 }),
});

/** Discriminator - which subset of fields is load-bearing for this row. */
const KindEnum = Type.Union([Type.Literal("compose"), Type.Literal("monorepo")]);

const RestartEnum = Type.Union([
  Type.Literal("no"),
  Type.Literal("always"),
  Type.Literal("on-failure"),
  Type.Literal("unless-stopped"),
]);

/** compose `healthcheck` block (mirrors ComposeHealthcheck in @repo/core). */
const HealthcheckSchema = Type.Object(
  {
    test: Type.Optional(
      Type.Union([
        Type.String({ maxLength: 2000 }),
        Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 }),
      ]),
    ),
    interval: Type.Optional(Type.String({ maxLength: 32 })),
    timeout: Type.Optional(Type.String({ maxLength: 32 })),
    retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    startPeriod: Type.Optional(Type.String({ maxLength: 32 })),
    disable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/**
 * Extended compose fields stored in the `advanced` JSONB blob (mirrors
 * ComposeAdvanced in @repo/core). Strict: new keys must be added here as they
 * become supported, so an unknown key is rejected rather than silently stored.
 * Grows with each phase (labels, entrypoint, caps, …).
 */
const AdvancedSchema = Type.Object(
  {
    // Each key is nullable because `advanced` is MERGED on update, not replaced
    // (see mergeAdvanced in service.service.ts): omitting a key means "leave it
    // alone" so a partial caller can't wipe the rest of the blob, which makes an
    // explicit `null` the way to say "remove this one".
    healthcheck: Type.Optional(Type.Union([HealthcheckSchema, Type.Null()])),
    /**
     * Per-service DEPLOY-TIME readiness gate, overriding the project's for this
     * service (mirrors OpenshipReadiness in @repo/core). Absent ⇒ inherit the
     * project's; neither ⇒ off, which is the default.
     *
     * Not `healthcheck` above: that's the daemon-run Docker HEALTHCHECK (a custom
     * command, on a loop, forever). This is the pipeline's one-shot "did it come
     * up?" and the only one of the two that can fail a deploy.
     */
    readiness: Type.Optional(
      Type.Union([
        Type.Object(
          {
            enabled: Type.Optional(Type.Boolean()),
            path: Type.Optional(Type.String({ maxLength: 2000 })),
            port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
            timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
            stabilization: Type.Optional(Type.Boolean()),
            stabilizationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
            onFailure: Type.Optional(Type.Union([Type.Literal("warn"), Type.Literal("fail")])),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    /** Per-service cpu/memory caps (compose `mem_limit`/`cpus` or
     *  `deploy.resources.limits`). Overrides the project-wide config field by
     *  field; `0` = no limit. The real ceiling is the target machine's capacity,
     *  enforced at deploy time — these bounds are sanity rails. */
    resources: Type.Optional(
      Type.Union([
        Type.Object(
          {
            cpuCores: Type.Optional(Type.Number({ minimum: 0, maximum: 1024 })),
            memoryMb: Type.Optional(Type.Number({ minimum: 0, maximum: 4194304 })),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    /** Custom east-west DNS alias resolving ALONGSIDE the service name on the
     *  project network. Free-form here (normalized + collision-checked by
     *  validateServiceAlias); `null`/`""` clears it. */
    alias: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    /**
     * Shared network / PID namespace (compose `network_mode` / `pid`) — the
     * compose file owns these, so they are here to be ROUND-TRIPPED, not authored:
     * a client that reads a service and PATCHes the whole `advanced` blob back
     * would otherwise 400 against this strict object. `host` is refused by
     * parseComposeNamespace wherever the value is read, and a `service:`/
     * `container:` reference is resolved and re-validated at deploy — so a
     * hand-set value can shorten no check. `null` clears it.
     */
    networkMode: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    pidMode: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    /**
     * Container ENTRYPOINT as argv (compose `entrypoint`). Same round-trip-only
     * reasoning as the two above: the compose file owns it, so this exists so a
     * client that PATCHes a whole read-back `advanced` blob isn't 400'd by the
     * strict object.
     *
     * An EMPTY array is meaningful and must survive validation — it is how compose
     * clears the image's ENTRYPOINT, so no `minItems` here. `null` removes the key
     * (back to the image default).
     */
    entrypoint: Type.Optional(
      Type.Union([Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100 }), Type.Null()]),
    ),
    /** Names-only provenance for raw Compose build-arg expressions. It must
     * round-trip with a service so a read/edit/write cannot turn an escaped
     * literal `$` into a second interpolation at deploy time. */
    buildArgTemplateKeys: Type.Optional(
      Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), {
        maxItems: 500,
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Shared compose-source fields (image, Dockerfile, network, runtime).
 * Spread into both Create and Update so a field added here propagates
 * to both surfaces - no more drift between validators.
 */
const ComposeFieldsBlock = {
  image: Type.Optional(Type.String({ maxLength: 500 })),
  build: Type.Optional(Type.String({ maxLength: 500 })),
  dockerfile: Type.Optional(Type.String({ maxLength: 500 })),
  buildArgs: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  ports: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 50 })),
  dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 50 })),
  environment: Type.Optional(Type.Record(Type.String(), Type.String())),
  volumes: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })),
  command: Type.Optional(Type.String({ maxLength: 1000 })),
  // #332: structured argv (docker-compose Cmd — no `sh -c`). Send an argv array
  // to run an entrypoint+CMD image correctly; `command` string stays supported.
  commandArgv: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100 })),
  advanced: Type.Optional(AdvancedSchema),
  exposed: Type.Optional(Type.Boolean()),
  exposedPort: Type.Optional(Type.String({ maxLength: 50 })),
  domain: Type.Optional(Type.String({ maxLength: 255 })),
  customDomain: Type.Optional(Type.String({ maxLength: 255 })),
  domainType: Type.Optional(Type.Union([Type.Literal("free"), Type.Literal("custom")])),
  // Additional public routes (one per port) — a multi-port service (e.g. Convex's
  // 3210 API + 3211 HTTP actions). Entry[0] mirrors the scalar fields above.
  publicEndpoints: Type.Optional(
    Type.Array(
      Type.Object({
        port: Type.Optional(Type.Union([Type.Number(), Type.String()])),
        domain: Type.Optional(Type.String({ maxLength: 255 })),
        customDomain: Type.Optional(Type.String({ maxLength: 255 })),
        domainType: Type.Optional(Type.Union([Type.Literal("free"), Type.Literal("custom")])),
      }),
      { maxItems: 20 },
    ),
  ),
  restart: Type.Optional(RestartEnum),
  enabled: Type.Optional(Type.Boolean()),
  sortOrder: Type.Optional(Type.Number({ minimum: 0 })),
} as const;

/**
 * Create a new service row. Accepts BOTH the compose-source fields AND
 * the monorepo-sub-app fields - the row's `kind` decides which subset is
 * the source of truth.
 *
 * Business-layer guards (in service.service.ts) enforce that when
 * `kind=monorepo`, the row carries a `rootDirectory`. The validator
 * keeps rootDirectory optional because it's nullable in the DB; the
 * service layer is the right place for the kind-conditional check.
 */
export const CreateServiceBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    kind: Type.Optional(KindEnum),
    ...ComposeFieldsBlock,
    ...MonorepoSubAppFieldsSchema,
  },
  // additionalProperties=false rejects unknown keys instead of silently
  // dropping them downstream. Without this, a client could PATCH/POST
  // `{ projectId: "victim", createdAt: ... }` and Drizzle's `.set()` would
  // write any key matching a real column straight to the row. The
  // validator must enforce the whitelist explicitly.
  { additionalProperties: false },
);

/**
 * Partial update - every field optional. Same shared blocks as Create.
 *
 * `kind` is intentionally OMITTED. Flipping a row's kind would invalidate
 * the schema invariant (compose rows have null monorepo fields and vice
 * versa) and bypass the kind-conditional guards createService enforces.
 * Switching kind is a deliberate destructive operation - delete the row
 * and re-create it under the new kind instead.
 */
export const UpdateServiceBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    ...ComposeFieldsBlock,
    ...MonorepoSubAppFieldsSchema,
    // Nullable ONLY here, not in Create: on a partial update absent means "keep"
    // and there has to be some other way to say "clear". `mergeServiceRoutingPatch`
    // reads these two with `!== undefined`, so null unroutes the row — which is
    // what a re-install that drops a hostname (the webmail proxy variant) needs to
    // express. On Create there is nothing to keep, so null would just be a second
    // spelling of absent.
    domain: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    customDomain: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    // #619: same reasoning as the two above, and for the same reason as `advanced`
    // — a keyed map on a PATCH has to be able to say "keep" and "clear" separately.
    // It matters more here than anywhere else on this endpoint: `environment` is the
    // only field MASKED on read, and reveal is off the automation surface, so a
    // client that replaced the whole map could neither see nor recover what it
    // destroyed. Nullable ONLY on update — Create/Sync own the whole set and keep
    // `Record<string,string>` (the ratchet in test/modules/services/service-schema-env
    // pins that asymmetry). The value type stays UNBOUNDED to match them: capping it
    // here alone would make a long value (CA chain, base64 kubeconfig) creatable and
    // then un-PATCH-able.
    environment: Type.Optional(
      Type.Union(
        [Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])), Type.Null()],
        {
          description:
            "MERGED onto the stored map, not replaced: omit a key to keep it, set a key to null to remove it, send null to clear every variable. An empty object changes nothing. Echo the •••••••• sentinel to keep a masked value unchanged.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * Reconcile a project's compose services against a parsed compose file.
 *
 * Entries carry every field `repos.service.syncFromCompose` consumes
 * (`ParsedComposeService` in @repo/db): `name` keys the row, `kind` filters
 * monorepo entries out, and the rest are the compose-owned and routing fields.
 * Declaring all of them - rather than leaning on `additionalProperties` - is
 * what lets an MCP agent discover the surface instead of guessing at it.
 *
 * Deliberately OPEN and unbounded, unlike Create/Update above: the payload is
 * machine-produced from `docker compose config`, whose scalars carry no length
 * limit and whose `restart` accepts forms outside the four-value enum
 * (`on-failure:3`). `advanced` stays an open object because ComposeAdvanced
 * grows per phase (healthcheck, files, ...) and this is an import path, not the
 * curated Create/Update surface. Mass assignment isn't a concern either way:
 * the repo layer rebuilds each row field-by-field through `toComposeSpec` +
 * `normalizeRoutingFields` rather than spreading the entry.
 *
 * `services: []` is left to the handler, which rejects it with its own message.
 */
export const SyncServicesBody = Type.Object({
  services: Type.Array(
    Type.Object(
      {
        name: Type.String({
          minLength: 1,
          description: "Compose service name - keys the service row.",
        }),
        kind: Type.Optional(
          Type.String({ description: 'Defaults to "compose"; "monorepo" entries are skipped.' }),
        ),
        image: Type.Optional(Type.String()),
        build: Type.Optional(
          Type.String({ description: "Build context, relative to the compose file." }),
        ),
        dockerfile: Type.Optional(Type.String()),
        buildArgs: Type.Optional(
          Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
        ),
        ports: Type.Optional(
          Type.Array(Type.String(), { description: 'Compose port mappings, e.g. "8080:80".' }),
        ),
        dependsOn: Type.Optional(Type.Array(Type.String())),
        environment: Type.Optional(Type.Record(Type.String(), Type.String())),
        volumes: Type.Optional(Type.Array(Type.String())),
        command: Type.Optional(
          Type.String({
            description:
              "Shell-string form. Stored for display and shell-word-split into argv; prefer `commandArgv` for a list command, whose string form here is a LOSSY join.",
          }),
        ),
        // #332: without this the only way to express a command was the string above,
        // so a list command round-tripped through this endpoint lost its quoting
        // (`["sh","-c","a && b"]` → five words). The CLI has always sent it.
        commandArgv: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Exact container argv (docker-compose Cmd semantics: overrides the image CMD, keeps its ENTRYPOINT, no implicit `sh -c`). Wins over `command`. `[]` clears the image CMD.",
          }),
        ),
        restart: Type.Optional(
          Type.String({
            description: 'Compose restart policy, e.g. "unless-stopped" or "on-failure:3".',
          }),
        ),
        advanced: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description: "Extended compose block stored as-is (healthcheck, files, ...).",
            },
          ),
        ),
        exposed: Type.Optional(Type.Boolean()),
        exposedPort: Type.Optional(Type.String()),
        domain: Type.Optional(Type.String()),
        customDomain: Type.Optional(Type.String()),
        domainType: Type.Optional(
          Type.String({
            description: '"custom" routes the custom domain; anything else is treated as "free".',
          }),
        ),
        publicEndpoints: Type.Optional(
          Type.Array(
            Type.Object(
              {
                port: Type.Optional(Type.Union([Type.Number(), Type.String()])),
                domain: Type.Optional(Type.String()),
                customDomain: Type.Optional(Type.String()),
                domainType: Type.Optional(Type.String()),
                targetPath: Type.Optional(Type.String()),
              },
              { additionalProperties: true },
            ),
            {
              description: "Additional public routes, one per port. Entry[0] mirrors the scalars.",
            },
          ),
        ),
      },
      { additionalProperties: true },
    ),
    {
      description:
        "The full service list from the compose file - services missing from it are removed.",
    },
  ),
});

export const SetServiceEnvVarsBody = Type.Object(
  {
    environment: EnvironmentScopeSchema,
    vars: Type.Array(
      Type.Object(
        {
          sourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          key: Type.String({ minLength: 1, maxLength: 256 }),
          value: Type.String({ maxLength: 10000 }),
          isSecret: Type.Optional(Type.Boolean({ default: false })),
        },
        { additionalProperties: false },
      ),
      { minItems: 0, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

export type TCreateServiceBody = Static<typeof CreateServiceBody>;
export type TUpdateServiceBody = Static<typeof UpdateServiceBody>;
export type TSyncServicesBody = Static<typeof SyncServicesBody>;
export type TSetServiceEnvVarsBody = Static<typeof SetServiceEnvVarsBody>;
