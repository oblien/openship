import { afterEach, describe, expect, it, vi } from "vitest";

const env = { CLOUD_MODE: false };
const isCloudConnectedForOrg = vi.fn();
const platform = vi.fn(() => ({ target: "selfhosted" }));

vi.mock("../../../src/config/env", () => ({ env }));
vi.mock("../../../src/lib/controller-helpers", () => ({ platform }));
vi.mock("../../../src/lib/cloud/session", () => ({ isCloudConnectedForOrg }));

describe("requireCloud edition gate", () => {
  afterEach(() => {
    env.CLOUD_MODE = false;
    isCloudConnectedForOrg.mockReset();
    platform.mockReset();
    platform.mockReturnValue({ target: "selfhosted" });
  });

  it("fails closed on operator even if a cloud session exists", async () => {
    env.CLOUD_MODE = false;
    isCloudConnectedForOrg.mockResolvedValue(true);
    const { requireCloud, CloudRequiredError } = await import("../../../src/lib/cloud/require-cloud");

    await expect(requireCloud("billing", { organizationId: "org_1" })).rejects.toBeInstanceOf(
      CloudRequiredError,
    );
    expect(isCloudConnectedForOrg).not.toHaveBeenCalled();
  });

  it("stays exempt on the SaaS itself (CLOUD_MODE)", async () => {
    env.CLOUD_MODE = true;
    platform.mockReturnValue({ target: "cloud" });
    const { requireCloud } = await import("../../../src/lib/cloud/require-cloud");

    await expect(requireCloud("billing", { organizationId: "org_1" })).resolves.toBeUndefined();
    expect(isCloudConnectedForOrg).not.toHaveBeenCalled();
  });
});
