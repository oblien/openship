/**
 * The env a backup and a restore each hand to a producer must be the SAME map.
 *
 * `pg_dump -U $POSTGRES_USER` takes the dump and `psql -U $POSTGRES_USER` reads it
 * back; if the two sides resolved that variable from different sources — or merged
 * them in a different order — the restore would authenticate as someone the dump
 * was never taken as. Both orchestrators used to spell the resolution out
 * separately, so these are the rules that made the duplication dangerous rather
 * than merely repetitive, pinned on the one function that now owns them.
 *
 * Uses the REAL encrypt/decryptEnvMap over a stub instance key: the point of the
 * boundary is that a producer receives PLAINTEXT, which a mocked codec would
 * assert nothing about.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The crypto helpers only need BETTER_AUTH_SECRET; the full zod env refuses to
// load outside desktop mode without INTERNAL_TOKEN.
vi.mock("../../../src/config/env", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-for-service-handle-unit-tests" },
}));

const h = vi.hoisted(() => ({
  /** `env_var` rows for the project — values are ciphertext, as stored. */
  envVars: [] as Array<{
    key: string;
    value: string;
    environment: string;
    serviceId: string | null;
  }>,
  /** Make the env-var read fail, standing in for an unreachable DB. */
  envVarsError: null as string | null,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      // Mirrors the real `envVarScope`: the environment always narrows, a null
      // serviceId means project-level rows ONLY, and a string means that service's
      // rows only. The bug this file now guards was a caller passing NEITHER, which
      // in the real query returns every row of every service and every environment —
      // so a mock that ignored the arguments would assert nothing.
      getEnvMap: async (_projectId: string, environment: string, serviceId?: string | null) => {
        if (h.envVarsError) throw new Error(h.envVarsError);
        const out: Record<string, string> = {};
        for (const row of h.envVars) {
          if (row.environment !== environment) continue;
          if (serviceId === null ? row.serviceId !== null : row.serviceId !== serviceId) continue;
          out[row.key] = row.value;
        }
        return out;
      },
    },
  },
}));

import { encrypt } from "../../../src/lib/encryption";
import { serviceHandleFor, withContainerEnv } from "../../../src/modules/backups/service-handle";

type ServiceRow = Parameters<typeof serviceHandleFor>[0];

/** A project-level env_var row (serviceId IS NULL). */
const projectVar = (key: string, value: string, environment = "production") => ({
  key,
  value: encrypt(value),
  environment,
  serviceId: null,
});

/** A service-scoped env_var row. */
const serviceVar = (
  key: string,
  value: string,
  serviceId = "svc_1",
  environment = "production",
) => ({ key, value: encrypt(value), environment, serviceId });

function serviceRow(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: "svc_1",
    projectId: "prj_1",
    name: "db",
    image: "postgres:16",
    environment: {},
    volumes: [],
    namespaceVolumes: true,
    ...over,
  } as ServiceRow;
}

const TARGET = { projectSlug: "shop", containerId: "ctr_abc" };

beforeEach(() => {
  h.envVars = [];
  h.envVarsError = null;
});

describe("serviceHandleFor", () => {
  it("decrypts project env vars at the boundary", async () => {
    h.envVars = [projectVar("POSTGRES_USER", "shopadmin")];

    const handle = await serviceHandleFor(serviceRow(), TARGET);

    expect(handle.env.POSTGRES_USER).toBe("shopadmin");
  });

  it("layers project → inline → service, exactly as the deploy path does", async () => {
    // This ORDER is the requirement, not a preference: the container being dumped
    // was started by `mergeServiceDeployEnv`, which puts the service row's inline
    // compose env ABOVE project-level rows and service-scoped rows above that. Any
    // other order aims `pg_dump -d $POSTGRES_DB` somewhere the running database is
    // not. Capture used to invert it — project-level rows beat inline.
    h.envVars = [projectVar("POSTGRES_DB", "project-level")];
    let handle = await serviceHandleFor(
      serviceRow({ environment: { POSTGRES_DB: "inline-compose" } }),
      TARGET,
    );
    expect(handle.env.POSTGRES_DB).toBe("inline-compose");

    h.envVars = [projectVar("POSTGRES_DB", "project-level"), serviceVar("POSTGRES_DB", "service-scoped")];
    handle = await serviceHandleFor(
      serviceRow({ environment: { POSTGRES_DB: "inline-compose" } }),
      TARGET,
    );
    expect(handle.env.POSTGRES_DB).toBe("service-scoped");
  });

  it("never reads ANOTHER service's env rows", async () => {
    // The blocker. In a normal compose project the app service also carries
    // POSTGRES_DB — it needs it to build its DSN — and the unscoped query returned
    // it, so the postgres service was dumped using the APP's value and the wrong
    // name was written into the manifest. A green run, a dump of the wrong database.
    h.envVars = [
      serviceVar("POSTGRES_DB", "the-real-db", "svc_1"),
      serviceVar("POSTGRES_DB", "app-services-copy", "svc_app"),
      serviceVar("POSTGRES_PASSWORD", "app-only", "svc_app"),
    ];

    const handle = await serviceHandleFor(serviceRow({ id: "svc_1" }), TARGET);

    expect(handle.env.POSTGRES_DB).toBe("the-real-db");
    expect(handle.env.POSTGRES_PASSWORD).toBeUndefined();
  });

  it("never reads ANOTHER environment's env rows", async () => {
    // The second half: with `production` and `preview` rows for one key, the
    // unscoped query returned both and whichever came back last won — so the same
    // policy dumped a different database on different nights with no config change.
    h.envVars = [
      projectVar("POSTGRES_DB", "prod-db", "production"),
      projectVar("POSTGRES_DB", "preview-db", "preview"),
    ];

    const prod = await serviceHandleFor(serviceRow(), { ...TARGET, environment: "production" });
    expect(prod.env.POSTGRES_DB).toBe("prod-db");

    const preview = await serviceHandleFor(serviceRow(), { ...TARGET, environment: "preview" });
    expect(preview.env.POSTGRES_DB).toBe("preview-db");
  });

  it("defaults to the production scope when no deployment named one", async () => {
    // `production` is the env_var column default — where a row lands when nothing
    // chose otherwise — so it is the only safe default for a handle built without
    // an active deployment.
    h.envVars = [
      projectVar("POSTGRES_DB", "prod-db", "production"),
      projectVar("POSTGRES_DB", "preview-db", "preview"),
    ];

    const handle = await serviceHandleFor(serviceRow(), TARGET);

    expect(handle.env.POSTGRES_DB).toBe("prod-db");
  });

  it("keeps the keys each source contributes alone", async () => {
    h.envVars = [projectVar("POSTGRES_PASSWORD", "s3cret")];

    const handle = await serviceHandleFor(
      serviceRow({ environment: { POSTGRES_DB: "shop" } }),
      TARGET,
    );

    expect(handle.env).toEqual({ POSTGRES_DB: "shop", POSTGRES_PASSWORD: "s3cret" });
  });

  it("degrades to the compose defaults when the env-var read fails", async () => {
    h.envVarsError = "connection terminated";

    const handle = await serviceHandleFor(
      serviceRow({ environment: { POSTGRES_DB: "shop" } }),
      TARGET,
    );

    expect(handle.env).toEqual({ POSTGRES_DB: "shop" });
  });

  it("reads a null environment and a null volumes column as empty", async () => {
    const handle = await serviceHandleFor(
      serviceRow({ environment: null, volumes: null }),
      TARGET,
    );

    expect(handle.env).toEqual({});
    expect(handle.volumes).toEqual([]);
  });

  it("takes the container id from the caller, never from the row", async () => {
    // The one field the two orchestrators legitimately disagree on: a backup
    // targets the live container or nothing, a restore has a narrow fallback.
    const handle = await serviceHandleFor(serviceRow(), {
      projectSlug: "shop",
      containerId: null,
    });

    expect(handle.containerId).toBeNull();
    expect(handle.projectSlug).toBe("shop");
  });
});

describe("withContainerEnv — the env the DB never recorded", () => {
  /** An executor that reports a container env, like the docker one does. */
  const executorWith = (env: Record<string, string>) =>
    ({ readContainerEnv: async () => env }) as unknown as Parameters<typeof withContainerEnv>[1];

  const handle = (over: Partial<Awaited<ReturnType<typeof serviceHandleFor>>> = {}) =>
    ({
      id: "svc_1",
      projectId: "prj_1",
      name: "postgres",
      image: "postgres:16-alpine",
      env: {},
      volumes: [],
      containerId: "c_pg",
      projectSlug: "openship",
      namespaceVolumes: false,
      ...over,
    }) as Awaited<ReturnType<typeof serviceHandleFor>>;

  it("fills in credentials for a service whose row carries no env", async () => {
    // The #611 case: the control plane's own service rows are built from running
    // containers, so `environment` is null and POSTGRES_DB was simply absent —
    // which read as "not a database" and sent the run to the volume fallback.
    const out = await withContainerEnv(
      handle(),
      executorWith({ POSTGRES_USER: "openship", POSTGRES_DB: "openship" }),
    );

    expect(out.env).toEqual({ POSTGRES_USER: "openship", POSTGRES_DB: "openship" });
  });

  it("lets the DB-resolved env WIN over the running container's", async () => {
    // Precedence is deliberate: an operator's env-var row is a statement of intent
    // that a redeploy will apply, and must not be shadowed by a value the current
    // container happens to have been started with.
    const out = await withContainerEnv(
      handle({ env: { POSTGRES_DB: "intended" } }),
      executorWith({ POSTGRES_DB: "stale-from-container", POSTGRES_USER: "openship" }),
    );

    expect(out.env.POSTGRES_DB).toBe("intended");
    // ...while still gaining what the DB said nothing about.
    expect(out.env.POSTGRES_USER).toBe("openship");
  });

  it("returns the handle untouched when the executor cannot inspect", async () => {
    // Bare and cloud executors have no container to read; absence is not an error.
    const base = handle({ env: { A: "1" } });
    expect(await withContainerEnv(base, {} as never)).toBe(base);
  });

  it("returns the handle untouched when there is no container", async () => {
    const base = handle({ containerId: null, env: { A: "1" } });
    expect(await withContainerEnv(base, executorWith({ B: "2" }))).toBe(base);
  });

  it("survives an inspect that throws rather than failing the run", async () => {
    const base = handle({ env: { A: "1" } });
    const broken = {
      readContainerEnv: async () => {
        throw new Error("daemon refused");
      },
    } as unknown as Parameters<typeof withContainerEnv>[1];

    expect((await withContainerEnv(base, broken)).env).toEqual({ A: "1" });
  });
});
