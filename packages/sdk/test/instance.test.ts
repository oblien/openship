import { describe, expect, it } from "vitest";
import { OpenshipClient } from "../src/client";
import { SDK_CAPABILITIES } from "@repo/contracts";

const archive = {
  kind: "openship-instance-export" as const,
  envelopeVersion: 4,
  createdAt: "2026-10-07",
  sourceDriver: "pglite" as const,
  dump: { formatVersion: 1, tables: { project: [{ id: "proj_one" }] } },
  secrets: { encoding: "plaintext", version: 1, entries: [{ value: "fixture-secret" }] },
};
function fixture(reply: () => Response, organizationId?: string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const ship = new OpenshipClient({
    baseUrl: "https://controller.test/prefix",
    token: "opsh_pat_fixture",
    organizationId,
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/health")) return Response.json({ sdk: SDK_CAPABILITIES });
      calls.push({ url: String(url), init });
      return reply();
    },
  });
  return { ship, calls };
}

describe("remote instance administration", () => {
  it("preserves an archive exactly without trying to interpret or rewrite credentials", async () => {
    const f = fixture(() => Response.json(archive));
    expect(await f.ship.instance.exportData()).toEqual(archive);
    expect(f.calls[0].url).toBe("https://controller.test/prefix/api/system/data-transfer/export");
    expect(new Headers(f.calls[0].init.headers).get("authorization")).toBe(
      "Bearer opsh_pat_fixture",
    );
  });
  it("preserves fixed organization binding when instance authority is refused, with no unscoped retry", async () => {
    const f = fixture(
      () =>
        Response.json(
          { error: "Instance administration requires an unbound credential" },
          { status: 403 },
        ),
      "org_limited",
    );
    await expect(f.ship.instance.exportData()).rejects.toMatchObject({ status: 403 });
    expect(f.calls).toHaveLength(1);
    expect(new Headers(f.calls[0].init.headers).get("x-organization-id")).toBe("org_limited");
  });
  it("submits only reviewed import options and does not retry an uncertain restore", async () => {
    const f = fixture(() => {
      throw new TypeError("Connection lost after commit");
    });
    const input = {
      file: archive,
      mode: "merge" as const,
      selection: {
        scope: "projects" as const,
        projectIds: ["proj_one"],
        conflictPolicy: "skip" as const,
        serverMappings: { old: "srv_target" },
        includeSecrets: false,
      },
    };
    await expect(f.ship.instance.importData(input)).rejects.toThrow("Connection lost");
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual(input);
  });
  it("requires an explicit valid import mode before submitting a restore", async () => {
    const f = fixture(() => {
      throw new Error("Must not dispatch");
    });
    // @ts-expect-error Wipe versus merge is an explicit caller choice.
    await expect(f.ship.instance.importData({ file: archive })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("reports unavailable control-plane migration instead of pretending it finished", async () => {
    const f = fixture(() =>
      Response.json(
        { error: "Controller deployment unavailable", code: "SERVER_MIGRATION_UNAVAILABLE" },
        { status: 501 },
      ),
    );
    await expect(
      f.ship.instance.migrateToServer({
        serverId: "srv_one",
        domain: { kind: "custom", hostname: "ship.example.test" },
      }),
    ).rejects.toMatchObject({ status: 501 });
    expect(f.calls).toHaveLength(1);
  });
  it("does not attach malformed secret-bearing archives to validation errors", async () => {
    const f = fixture(() => Response.json({ secrets: "fixture-private-value" }));
    await expect(f.ship.instance.exportData()).rejects.toMatchObject({ status: 502, body: null });
  });
});
