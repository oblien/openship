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
  envVars: [] as Array<{ key: string; value: string }>,
  /** Make the env-var read fail, standing in for an unreachable DB. */
  envVarsError: null as string | null,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      listEnvVars: async () => {
        if (h.envVarsError) throw new Error(h.envVarsError);
        return h.envVars;
      },
    },
  },
}));

import { encrypt } from "../../../src/lib/encryption";
import { serviceHandleFor } from "../../../src/modules/backups/service-handle";

type ServiceRow = Parameters<typeof serviceHandleFor>[0];

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
    h.envVars = [{ key: "POSTGRES_USER", value: encrypt("shopadmin") }];

    const handle = await serviceHandleFor(serviceRow(), TARGET);

    expect(handle.env.POSTGRES_USER).toBe("shopadmin");
  });

  it("lets a user-set project var beat the compose default of the same key", async () => {
    h.envVars = [{ key: "POSTGRES_USER", value: encrypt("shopadmin") }];

    const handle = await serviceHandleFor(
      serviceRow({ environment: { POSTGRES_USER: "postgres" } }),
      TARGET,
    );

    expect(handle.env.POSTGRES_USER).toBe("shopadmin");
  });

  it("keeps the keys each source contributes alone", async () => {
    h.envVars = [{ key: "POSTGRES_PASSWORD", value: encrypt("s3cret") }];

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
