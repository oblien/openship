import { describe, expect, it } from "vitest";
import type { DatabaseDump } from "@repo/db";
import { projectPromotionDigest } from "@repo/platform/engine/lib/cloud/project-promotion";

function source(): DatabaseDump {
  return {
    formatVersion: 1,
    exportedAt: "2026-10-05T00:00:00.000Z",
    sourceDriver: "pglite",
    scope: { kind: "project", projectId: "proj_checksum" },
    tables: {
      project: [{ id: "proj_checksum", slug: "receipt-test", cloudPromotion: null, lifecycleOperation: null }],
      service: [
        {
          id: "svc_b",
          environment: { é: "accent", z: "last", A: "first" },
          ports: ["3000", "4000"],
        },
        {
          id: "svc_a",
          environment: JSON.parse('{"constructor":"ordinary","__proto__":{"z":1,"a":2}}'),
        },
      ],
      env_var: [
        { id: "env_b", value: "2" },
        { id: "env_a", value: "1" },
      ],
    },
  };
}

describe("project promotion checksum compatibility", () => {
  // Recorded before sharing the JSON-ordering helper. Existing receipts must
  // stay valid after an upgrade, including arbitrary JSON configuration keys.
  const receiptDigest = "4b4e87c7216557845e44ea233d64c1f7544e190cd8aca8b23e0b201c83bd7bef";

  it("retains the checksum stored by the original implementation", () => {
    expect(projectPromotionDigest(source())).toBe(receiptDigest);
  });

  it("ignores query order and the transient cleanup journal", () => {
    const dump = source();
    dump.tables.service[0].environment = { A: "first", z: "last", é: "accent" };
    for (const rows of Object.values(dump.tables)) rows.reverse();
    dump.tables = Object.fromEntries(Object.entries(dump.tables).reverse());
    dump.tables.project[0].deletionInProgress = true;
    dump.tables.project[0].lifecycleOperation = { kind: "delete", status: "failed", error: "Cleanup failed" };
    dump.tables.project[0].cloudPromotion = { cleanupInProgress: true };
    dump.tables.project[0].updatedAt = "2026-10-06T00:00:00.000Z";
    expect(projectPromotionDigest(dump)).toBe(receiptDigest);
  });

  it("detects a configuration array's changed order", () => {
    const dump = source();
    dump.tables.service[0].ports = ["4000", "3000"];
    expect(projectPromotionDigest(dump)).not.toBe(receiptDigest);
  });
});
