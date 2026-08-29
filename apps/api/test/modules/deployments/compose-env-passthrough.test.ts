/**
 * Issue #614: a compose passthrough variable (`${VAR:-}` / `${VAR}`) parses to
 * `""`, is persisted onto the service row with its provenance stripped, and then
 * replaced the operator's project-level value with an empty string at deploy —
 * worse than unset, since `KEY=` also masks the image's own `ENV` default.
 *
 * The rule under test: an empty INLINE value never clears a configured one. The
 * trade-off that buys, and the escape hatch that survives it, are pinned below
 * so neither can be removed by accident.
 */

import { describe, expect, it } from "vitest";

import { parseComposeFile } from "../../../src/lib/compose-parser";
import {
  mergeServiceDeployEnv,
  type ServiceEnvLayers,
} from "../../../src/modules/deployments/compose/service-env-layers";

const layers = (over: Partial<ServiceEnvLayers> = {}): ServiceEnvLayers => ({
  project: {},
  frozen: {},
  inline: {},
  service: {},
  ...over,
});

describe("compose env passthrough vs configured values (#614)", () => {
  it("parses passthrough placeholders to empty strings, keeping provenance the row will lose", () => {
    const parsed = parseComposeFile(`
services:
  web:
    image: node:20
    environment:
      CONFIG_VAR: \${CONFIG_VAR:-}
      ANOTHER_VAR: \${ANOTHER_VAR}
      WITH_DEFAULT: \${WITH_DEFAULT:-default_fallback}
      AUTHORED_EMPTY: ""
`);
    const service = parsed.services[0];

    expect(service?.environment).toEqual({
      CONFIG_VAR: "",
      ANOTHER_VAR: "",
      WITH_DEFAULT: "default_fallback",
      AUTHORED_EMPTY: "",
    });

    // The parser CAN tell the two empties apart — a placeholder carries meta, an
    // authored literal carries none. The service row has no `environmentMeta`
    // column, which is why the merge has to decide on value shape instead.
    expect(service?.environmentMeta?.CONFIG_VAR).toMatchObject({
      source: "default",
      variable: "CONFIG_VAR",
      defaultValue: "",
    });
    expect(service?.environmentMeta?.ANOTHER_VAR).toMatchObject({
      source: "missing",
      variable: "ANOTHER_VAR",
    });
    expect(service?.environmentMeta?.AUTHORED_EMPTY).toBeUndefined();
  });

  it("keeps the project value the operator configured, and reports the substitution", () => {
    const inline =
      parseComposeFile(`
services:
  api:
    image: my-app:latest
    environment:
      DATABASE_URL: \${DATABASE_URL:-}
      API_SECRET: \${API_SECRET}
      PORT: "3000"
`).services[0]?.environment ?? {};

    const merged = mergeServiceDeployEnv(
      layers({
        project: {
          DATABASE_URL: "postgresql://user:pass@db:5432/production_db",
          API_SECRET: "super-secret-token-12345",
          PORT: "8080",
        },
        inline,
      }),
      false,
    );

    expect(merged.env.DATABASE_URL).toBe("postgresql://user:pass@db:5432/production_db");
    expect(merged.env.API_SECRET).toBe("super-secret-token-12345");
    // A non-empty inline literal still wins — that precedence is the point of
    // the inline layer and is unchanged.
    expect(merged.env.PORT).toBe("3000");

    // Names only, never values: this goes to the deploy log.
    expect(merged.deferredEmpty.sort()).toEqual(["API_SECRET", "DATABASE_URL"]);
  });

  it("defers to the frozen capture too — the layer every real non-rollback deploy has", () => {
    // `dep.envVars` is a snapshot of the operator's env, not of this service's
    // inline map, so on a normal deploy the frozen layer is what an empty inline
    // value is actually measured against.
    const merged = mergeServiceDeployEnv(
      layers({
        project: { CONFIG_PARAM: "stale-project" },
        frozen: { CONFIG_PARAM: "captured-at-deploy" },
        inline: { CONFIG_PARAM: "" },
      }),
      false,
    );

    expect(merged.env.CONFIG_PARAM).toBe("captured-at-deploy");
    expect(merged.deferredEmpty).toEqual(["CONFIG_PARAM"]);
  });

  it("replays the release unchanged on a rollback, and reports nothing it did not decide", () => {
    const merged = mergeServiceDeployEnv(
      layers({
        project: { CONFIG_PARAM: "today" },
        frozen: { CONFIG_PARAM: "release" },
        inline: { CONFIG_PARAM: "" },
      }),
      true,
    );

    // frozenWins: the snapshot is layered last and still wins outright.
    expect(merged.env.CONFIG_PARAM).toBe("release");
    // The deferral didn't pick this value, so naming it in the log would point
    // the operator at the wrong layer.
    expect(merged.deferredEmpty).toEqual([]);
  });

  it("still lets a service-scoped row force a variable blank — the escape hatch", () => {
    const merged = mergeServiceDeployEnv(
      layers({
        project: { HTTP_PROXY: "http://corp:3128" },
        inline: { HTTP_PROXY: "" },
        service: { HTTP_PROXY: "" },
      }),
      false,
    );

    expect(merged.env.HTTP_PROXY).toBe("");
    expect(merged.deferredEmpty).toEqual([]);
  });

  it("ACCEPTED TRADE-OFF: an inline empty can no longer blank a configured value", () => {
    // Deliberate, and the cost of deciding on value shape rather than on the
    // parser's recorded intent: an author who wrote `HTTP_PROXY: ""` on purpose
    // (or blanked it in the service Env tab, which writes the same column) no
    // longer clears the project value — they must use a service-scoped row, as
    // in the case above. Carrying `environmentMeta` onto the row via `advanced`
    // would let this decide on intent instead; if that lands, this expectation
    // is the one to revisit.
    const merged = mergeServiceDeployEnv(
      layers({ project: { HTTP_PROXY: "http://corp:3128" }, inline: { HTTP_PROXY: "" } }),
      false,
    );

    expect(merged.env.HTTP_PROXY).toBe("http://corp:3128");
    expect(merged.deferredEmpty).toEqual(["HTTP_PROXY"]);
  });

  it("resolves an embedded expression against the final service-scoped env (#673)", () => {
    const service = parseComposeFile(`
services:
  api:
    image: my-app:latest
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      DATABASE_URL: postgresql://username:\${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@postgres:5432/app
`).services[0]!;
    const inline = { ...service.environment, ...service.environmentTemplates };

    const merged = mergeServiceDeployEnv(
      layers({
        inline,
        templateKeys: service.advanced?.environmentTemplateKeys,
        service: { POSTGRES_PASSWORD: "service-secret" },
      }),
      false,
    );

    expect(merged.env.POSTGRES_PASSWORD).toBe("service-secret");
    expect(merged.env.DATABASE_URL).toBe(
      "postgresql://username:service-secret@postgres:5432/app",
    );
    expect(merged.missingRequired).toEqual([]);
    expect(merged.deferredEmpty).toEqual([]);
  });

  it("reports a required embedded variable when no layer provides it", () => {
    const service = parseComposeFile(`
services:
  api:
    image: my-app:latest
    environment:
      DATABASE_URL: postgresql://username:\${POSTGRES_PASSWORD:?set it}@postgres:5432/app
`).services[0]!;

    const merged = mergeServiceDeployEnv(
      layers({
        inline: { ...service.environment, ...service.environmentTemplates },
        templateKeys: service.advanced?.environmentTemplateKeys,
      }),
      false,
    );

    expect(merged.missingRequired).toEqual([
      { variable: "POSTGRES_PASSWORD", message: "set it" },
    ]);
  });

  it("lets a higher-priority service value replace the templated target entirely", () => {
    const service = parseComposeFile(`
services:
  api:
    image: my-app:latest
    environment:
      DATABASE_URL: postgresql://username:\${POSTGRES_PASSWORD:?set it}@postgres:5432/app
`).services[0]!;

    const merged = mergeServiceDeployEnv(
      layers({
        inline: { ...service.environment, ...service.environmentTemplates },
        templateKeys: service.advanced?.environmentTemplateKeys,
        service: { DATABASE_URL: "manual-service-url" },
      }),
      false,
    );

    expect(merged.env.DATABASE_URL).toBe("manual-service-url");
    expect(merged.missingRequired).toEqual([]);
  });

  it("honors an authored empty literal when parser provenance is available", () => {
    const merged = mergeServiceDeployEnv(
      layers({
        project: { HTTP_PROXY: "http://corp:3128" },
        inline: { HTTP_PROXY: "" },
        templateKeys: [],
      }),
      false,
    );

    expect(merged.env.HTTP_PROXY).toBe("");
    expect(merged.deferredEmpty).toEqual([]);
  });

  it("sets a passthrough key that no other layer defines, rather than dropping it", () => {
    // Skipping instead of assigning would delete the variable from the container
    // — a third behavior neither reading of the compose file asked for.
    const merged = mergeServiceDeployEnv(layers({ inline: { UNSET_PASSTHROUGH: "" } }), false);

    expect(merged.env).toHaveProperty("UNSET_PASSTHROUGH", "");
    expect(merged.deferredEmpty).toEqual([]);
  });

  it("does not defer when the configured value is itself empty", () => {
    const merged = mergeServiceDeployEnv(
      layers({ project: { CONFIG_PARAM: "" }, inline: { CONFIG_PARAM: "" } }),
      false,
    );

    expect(merged.env.CONFIG_PARAM).toBe("");
    expect(merged.deferredEmpty).toEqual([]);
  });
});
