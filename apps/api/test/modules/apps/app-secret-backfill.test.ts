import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A generated config value must EXIST on every path that reaches a container.
 *
 * `installApp` writes them only for the services one call creates, so an adopted draft
 * — every retry after a failed first attempt — kept whatever the first pass had managed
 * to write. Webmail then deployed a container with no `SESSION_ENCRYPTION_KEY`, which
 * its image treats as fatal: a crash loop the deploy reported as success (issue #566).
 *
 * The two properties that make the repair safe are as important as the repair:
 *   - presence is decided from the RAW stored keys, so an undecryptable row (after a
 *     BETTER_AUTH_SECRET rotation) is never overwritten — `mergeEnvVars` deletes before
 *     it inserts, and the value it would destroy can be a database password;
 *   - a key the template inlines into some OTHER string is never minted, because those
 *     copies were written once and would keep contradicting the new value.
 */

const { getEnvMap, mergeEnvVars, listByProject } = vi.hoisted(() => ({
  getEnvMap: vi.fn(async () => ({}) as Record<string, string>),
  mergeEnvVars: vi.fn(async () => {}),
  listByProject: vi.fn(async () => [{ id: "svc-webmail", name: "webmail" }]),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { getEnvMap, mergeEnvVars, findDraftByAppTemplate: vi.fn() },
    service: { listByProject },
    customAppTemplate: { findByAppId: async () => undefined, listByOrg: async () => [] },
  },
}));

// Stubbed for the same reason the sibling install test stubs them: importing the real
// service layer drags in lib/auth, which needs a full `schema` export off @repo/db.
vi.mock("../../../src/modules/projects/project-crud.service", () => ({
  createProject: vi.fn(),
}));
vi.mock("../../../src/modules/services/service.service", () => ({
  createService: vi.fn(),
  updateService: vi.fn(),
  setServiceEnvVars: vi.fn(),
}));
vi.mock("../../../src/lib/cloud/require-cloud", () => ({ requireCloud: vi.fn() }));

import { getAppTemplate } from "@repo/core";
import { ensureGeneratedAppSecrets } from "../../../src/modules/apps/app-install.service";
import { decrypt, encrypt } from "../../../src/lib/encryption";

const WEBMAIL = getAppTemplate("webmail")!;

/** The upsert list from the single mergeEnvVars call, keyed by env var name. */
function upserted() {
  const [, , upserts] = mergeEnvVars.mock.calls[0] as unknown as [
    string,
    string,
    { key: string; value: string; isSecret: boolean }[],
  ];
  return new Map(upserts.map((u) => [u.key, u]));
}

beforeEach(() => {
  vi.clearAllMocks();
  getEnvMap.mockResolvedValue({});
  listByProject.mockResolvedValue([{ id: "svc-webmail", name: "webmail" }]);
});

describe("ensureGeneratedAppSecrets", () => {
  it("mints the webmail secrets the image refuses to boot without", async () => {
    const written = await ensureGeneratedAppSecrets("prj_1", WEBMAIL);

    expect(written).toContain("SESSION_ENCRYPTION_KEY");
    expect(written).toContain("BRANDING_ADMIN_TOKEN");
    const vars = upserted();
    // Stored encrypted, and a real value — a blank row boots no better than none.
    expect(decrypt(vars.get("SESSION_ENCRYPTION_KEY")!.value).length).toBeGreaterThan(16);
    expect(vars.get("SESSION_ENCRYPTION_KEY")!.isSecret).toBe(true);
    expect(mergeEnvVars).toHaveBeenCalledTimes(1);
    // Merge, never replace: the settings the app already has must survive.
    expect(mergeEnvVars.mock.calls[0][3]).toEqual([]);
    expect(mergeEnvVars.mock.calls[0][4]).toBe("svc-webmail");
  });

  it("reuses a stored key instead of rotating it", async () => {
    getEnvMap.mockResolvedValue({ SESSION_ENCRYPTION_KEY: "ciphertext-we-cannot-read" });

    const written = await ensureGeneratedAppSecrets("prj_1", WEBMAIL);

    expect(written).not.toContain("SESSION_ENCRYPTION_KEY");
    expect(written).toContain("BRANDING_ADMIN_TOKEN");
    expect(upserted().has("SESSION_ENCRYPTION_KEY")).toBe(false);
  });

  /**
   * The destructive case. `decryptEnvMap` DROPS keys it cannot decrypt, so deciding
   * presence from decrypted values would report every secret as missing after a
   * BETTER_AUTH_SECRET rotation and overwrite the only copy.
   */
  it("leaves an undecryptable row alone rather than overwriting it", async () => {
    getEnvMap.mockResolvedValue({
      SESSION_ENCRYPTION_KEY: "not-valid-ciphertext",
      BRANDING_ADMIN_TOKEN: "also-not-valid",
    });

    expect(await ensureGeneratedAppSecrets("prj_1", WEBMAIL)).toEqual([]);
    expect(mergeEnvVars).not.toHaveBeenCalled();
  });

  it("does nothing for a service row that does not exist yet", async () => {
    listByProject.mockResolvedValue([]);

    expect(await ensureGeneratedAppSecrets("prj_1", WEBMAIL)).toEqual([]);
    expect(mergeEnvVars).not.toHaveBeenCalled();
  });

  it("is a no-op for a template with no generated fields", async () => {
    const plain = { ...WEBMAIL, configFields: [] };

    expect(await ensureGeneratedAppSecrets("prj_1", plain)).toEqual([]);
    expect(getEnvMap).not.toHaveBeenCalled();
  });

  /**
   * Redis inlines `VALKEY_PASSWORD` into a mounted `redis.conf`. Minting a new one here
   * would write password A into the env row while the file still says B — a server
   * nobody can authenticate against, with nothing logged.
   */
  it("refuses to mint a key the template inlines elsewhere", async () => {
    const redis = getAppTemplate("redis")!;
    const inlinedKeys = (redis.configFields ?? [])
      .filter((f) => f.generate)
      .map((f) => f.key);
    listByProject.mockResolvedValue(
      (redis.services ?? []).map((s, i) => ({ id: `svc-${i}`, name: s.name })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const written = await ensureGeneratedAppSecrets("prj_1", redis);

    for (const key of inlinedKeys) expect(written).not.toContain(key);
    expect(mergeEnvVars).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * Ghost's `ghostdb` group spans TWO services: MYSQL_ROOT_PASSWORD on ghost-db and
   * database__connection__password on ghost. They are the same password, so a
   * per-service view of the group repairs one half with a value the other half does not
   * know — an app that cannot authenticate to its own MySQL, silently.
   */
  it("gives one value to a generate group that spans services", async () => {
    const ghost = getAppTemplate("ghost")!;
    listByProject.mockResolvedValue(
      (ghost.services ?? []).map((s) => ({ id: `svc-${s.name}`, name: s.name })),
    );

    await ensureGeneratedAppSecrets("prj_1", ghost);

    const all = new Map(
      (mergeEnvVars.mock.calls as unknown as [string, string, { key: string; value: string }[]][])
        .flatMap(([, , ups]) => ups.map((u) => [u.key, decrypt(u.value)] as const)),
    );
    expect(all.get("MYSQL_ROOT_PASSWORD")).toBeDefined();
    expect(all.get("MYSQL_ROOT_PASSWORD")).toBe(all.get("database__connection__password"));
  });

  /**
   * Half the pair already stored: the missing half must be REPAIRED to the stored
   * value, never rotated to a fresh one — rotating would break the half that works.
   */
  it("repairs the missing half of a group from the stored half", async () => {
    const ghost = getAppTemplate("ghost")!;
    listByProject.mockResolvedValue(
      (ghost.services ?? []).map((s) => ({ id: `svc-${s.name}`, name: s.name })),
    );
    getEnvMap.mockImplementation(async (_p: string, _e: string, serviceId: string) =>
      serviceId === "svc-ghost-db" ? { MYSQL_ROOT_PASSWORD: encrypt("the-live-password") } : {},
    );

    const written = await ensureGeneratedAppSecrets("prj_1", ghost);

    expect(written).toEqual(["database__connection__password"]);
    const [, , upserts] = mergeEnvVars.mock.calls[0] as unknown as [
      string,
      string,
      { key: string; value: string }[],
    ];
    expect(decrypt(upserts[0].value)).toBe("the-live-password");
  });

  it("leaves a group alone when the stored half cannot be read", async () => {
    const ghost = getAppTemplate("ghost")!;
    listByProject.mockResolvedValue(
      (ghost.services ?? []).map((s) => ({ id: `svc-${s.name}`, name: s.name })),
    );
    getEnvMap.mockImplementation(async (_p: string, _e: string, serviceId: string) =>
      serviceId === "svc-ghost-db" ? { MYSQL_ROOT_PASSWORD: "unreadable-ciphertext" } : {},
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Anything minted here would disagree with the copy MySQL is already using.
    expect(await ensureGeneratedAppSecrets("prj_1", ghost)).toEqual([]);
    expect(mergeEnvVars).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
