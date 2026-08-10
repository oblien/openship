import { describe, it, expect, vi } from "vitest";

// GATE 1: whole-instance export/import must refuse on a multi-tenant (CLOUD_MODE)
// instance — defense-in-depth beyond the route-mount gate. Flip only CLOUD_MODE,
// keep every other real env field so the module graph still loads.
vi.mock("../../../config/env", async (orig) => {
  const actual = await orig<typeof import("../../../config/env")>();
  return { ...actual, env: { ...actual.env, CLOUD_MODE: true } };
});

import { exportInstance } from "./export.service";
import { importInstance } from "./import.service";
import { CloudInstanceNotTransferableError } from "./errors";
import type { DataTransferFile } from "./types";

describe("data-transfer CLOUD_MODE gate (GATE 1)", () => {
  it("exportInstance refuses when CLOUD_MODE", async () => {
    await expect(exportInstance({})).rejects.toBeInstanceOf(CloudInstanceNotTransferableError);
  });

  it("importInstance refuses when CLOUD_MODE — before touching the file or DB", async () => {
    // A dummy file is fine: the gate fires before envelope validation / any write.
    const file = { kind: "openship-instance-export" } as unknown as DataTransferFile;
    await expect(importInstance({ file, mode: "wipe" })).rejects.toBeInstanceOf(
      CloudInstanceNotTransferableError,
    );
  });
});
