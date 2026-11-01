import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  cloud: true,
  destination: vi.fn(),
  resolve: vi.fn(),
  hydrate: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { backupDestination: { findById: h.destination } } }));
vi.mock("@repo/adapters", () => ({ resolveDestination: h.resolve }));
vi.mock("../../config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
    BETTER_AUTH_SECRET: "test-key",
    OPENSHIP_PUBLIC_URL: "https://actions.example.test",
  },
}));
vi.mock("../../lib/authorization", () => ({ authorization: { authorize: vi.fn() } }));
vi.mock("../../lib/execution-authority", () => ({
  captureExecutionAuthority: vi.fn(),
  resolveExecutionAuthority: vi.fn(),
}));
vi.mock("../backup-destinations/hydrate-server", () => ({ toAdapterRow: h.hydrate }));
vi.mock("./access", () => ({ authorizeActionRun: vi.fn() }));
import { actionStorageDestination } from "./storage";

beforeEach(() => {
  vi.resetAllMocks();
  h.cloud = true;
  h.hydrate.mockImplementation(async (row) => row);
  h.resolve.mockReturnValue({ capabilities: new Set(["rangedGet"]) });
});
describe("Actions artifact destination ownership", () => {
  it("rejects local storage in Cloud before resolving any local adapter", async () => {
    h.destination.mockResolvedValue({ id: "local", organizationId: "org", kind: "local" });
    await expect(actionStorageDestination("org", "local")).rejects.toMatchObject({
      code: "ACTIONS_STORAGE_UNSUPPORTED",
    });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.hydrate).not.toHaveBeenCalled();
    h.cloud = false;
    expect(await actionStorageDestination("org", "local")).toMatchObject({
      capabilities: expect.any(Set),
    });
  });
  it("conceals another organization's destination before reading its credentials", async () => {
    h.destination.mockResolvedValue({ id: "s3", organizationId: "other", kind: "s3_compatible" });
    await expect(actionStorageDestination("org", "s3")).rejects.toMatchObject({ statusCode: 404 });
    expect(h.hydrate).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
  });
  it("uses the existing S3 adapter only when it supports the required download protocol", async () => {
    h.destination.mockResolvedValue({ id: "s3", organizationId: "org", kind: "s3_compatible" });
    await actionStorageDestination("org", "s3");
    expect(h.resolve).toHaveBeenCalledOnce();
    h.resolve.mockReturnValue({ capabilities: new Set() });
    await expect(actionStorageDestination("org", "s3")).rejects.toMatchObject({
      code: "ACTIONS_STORAGE_UNSUPPORTED",
    });
  });
});
