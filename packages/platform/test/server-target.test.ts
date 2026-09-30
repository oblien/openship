import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: null as null | { id: string; managementMode: "managed" | "observe_only" },
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      getInOrganization: vi.fn(async () => h.row),
    },
  },
}));

import { requireManagedOrgServer, requireOrgServer } from "../src/engine/lib/server-target";

beforeEach(() => {
  h.row = { id: "server-1", managementMode: "managed" };
});

describe("server target capability", () => {
  it("keeps observe-only rows available to read-only server resolution", async () => {
    h.row = { id: "server-1", managementMode: "observe_only" };
    await expect(requireOrgServer("server-1", "org-1")).resolves.toBe(h.row);
  });

  it("accepts a managed deployment target", async () => {
    await expect(requireManagedOrgServer("server-1", "org-1")).resolves.toBe(h.row);
  });

  it("rejects an observe-only deployment target with a stable conflict", async () => {
    h.row = { id: "server-1", managementMode: "observe_only" };
    await expect(requireManagedOrgServer("server-1", "org-1")).rejects.toMatchObject({
      statusCode: 409,
      code: "SERVER_OBSERVE_ONLY",
    });
  });
});
