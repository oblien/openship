import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, "")),
}));

vi.mock("@repo/db", () => ({
  repos: {
    swarmStack: {
      listManagedInputsInOrganization: mocks.list,
      getManagedInputInOrganization: mocks.get,
      upsertManagedInputInOrganization: mocks.upsert,
      removeManagedInputInOrganization: mocks.remove,
    },
  },
}));

vi.mock("../../lib/credential-encryption", () => ({
  encryptSecretField: mocks.encrypt,
  decryptSecretField: mocks.decrypt,
}));

import {
  listManagedInputs,
  removeManagedInput,
  resolveManagedInputPayloads,
  saveManagedInput,
} from "./swarm-managed-input.service";

const storedInput = {
  id: "swmi-1",
  projectId: "project-a",
  kind: "secret" as const,
  logicalName: "api-token",
  valueEnc: "enc:top-secret",
  createdByUserId: "user-a",
  updatedByUserId: "user-a",
  createdAt: new Date("2026-07-30T00:00:00.000Z"),
  updatedAt: new Date("2026-07-30T00:00:00.000Z"),
};

describe("managed Swarm inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([storedInput]);
    mocks.get.mockResolvedValue(storedInput);
    mocks.upsert.mockResolvedValue(storedInput);
    mocks.remove.mockResolvedValue(true);
  });

  it("redacts encrypted payloads from operator-readable metadata", async () => {
    await expect(listManagedInputs("project-a", "org-a")).resolves.toEqual([
      expect.objectContaining({ id: "swmi-1", kind: "secret", logicalName: "api-token", hasValue: true }),
    ]);
    const listed = await listManagedInputs("project-a", "org-a");
    expect(listed[0]).not.toHaveProperty("valueEnc");
    expect(JSON.stringify(listed)).not.toContain("top-secret");
  });

  it("encrypts a value before the project-scoped upsert and returns only safe metadata", async () => {
    const saved = await saveManagedInput({
      projectId: "project-a",
      organizationId: "org-a",
      userId: "user-a",
      kind: "secret",
      logicalName: " api-token ",
      value: "top-secret",
    });

    expect(mocks.encrypt).toHaveBeenCalledWith("top-secret");
    expect(mocks.upsert).toHaveBeenCalledWith("project-a", "org-a", expect.objectContaining({
      kind: "secret",
      logicalName: "api-token",
      valueEnc: "enc:top-secret",
    }));
    expect(saved).toMatchObject({ id: "swmi-1", hasValue: true });
    expect(saved).not.toHaveProperty("valueEnc");
  });

  it("refuses deletion when an input belongs to a different project in the same organization", async () => {
    mocks.get.mockResolvedValue({ ...storedInput, projectId: "project-b" });

    await expect(removeManagedInput("swmi-1", "project-a", "org-a"))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("decrypts payloads only for the deployment path", async () => {
    await expect(resolveManagedInputPayloads("project-a", "org-a")).resolves.toEqual([
      { kind: "secret", logicalName: "api-token", content: "top-secret" },
    ]);
    expect(mocks.decrypt).toHaveBeenCalledWith("enc:top-secret");
  });
});
