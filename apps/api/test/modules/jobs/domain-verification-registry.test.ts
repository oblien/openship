import "../mail/_setup-env";
import { describe, expect, it, vi } from "vitest";

const verifyPendingDomains = vi.hoisted(() => vi.fn());

vi.mock("../../../src/modules/domains/domain.service", () => ({
  verifyPendingDomains,
}));

import { SYSTEM_JOB_BY_KEY } from "../../../src/modules/jobs/job.registry";

describe("domains:verify-pending system job", () => {
  it("is available on Desktop and every other platform", () => {
    const job = SYSTEM_JOB_BY_KEY.get("domains:verify-pending");

    expect(job).toBeDefined();
    expect(job?.available).toBeUndefined();
    expect(job?.defaultCron).toBe("*/13 * * * *");
  });

  it("reports verification and SSL retry outcomes", async () => {
    verifyPendingDomains.mockResolvedValueOnce({
      verified: 2,
      failed: 1,
      stillPending: 3,
      total: 6,
      sslIssued: 4,
      sslRetrying: 1,
      details: [],
    });

    const result = await SYSTEM_JOB_BY_KEY.get("domains:verify-pending")!.run();

    expect(verifyPendingDomains).toHaveBeenCalledOnce();
    expect(result).toEqual({
      verified: 2,
      failed: 1,
      pending: 3,
      total: 6,
      sslIssued: 4,
      sslRetrying: 1,
    });
  });
});
