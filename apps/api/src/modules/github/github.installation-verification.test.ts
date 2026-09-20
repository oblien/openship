import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getUserToken: vi.fn(),
  ghFetch: vi.fn(),
  appFetch: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({
  getUserToken: h.getUserToken,
  appFetch: h.appFetch,
}));
vi.mock("@repo/platform/engine/modules/github/github.http", () => ({ ghFetch: h.ghFetch }));

import { verifyGitHubInstallationForUser } from "@repo/platform/engine/modules/github/github.installation-verification";

const installation = {
  id: 42,
  account: { login: "Acme", id: 700, avatar_url: "", type: "Organization" },
  app_id: 9,
  target_type: "Organization",
  permissions: {},
  events: [],
};

describe("verifyGitHubInstallationForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getUserToken.mockResolvedValue("github-user-token");
    h.ghFetch.mockResolvedValue({ total_count: 1, installations: [installation] });
    h.appFetch.mockResolvedValue(installation);
  });

  it("requires the initiating user's GitHub authorization", async () => {
    h.getUserToken.mockResolvedValue(null);

    await expect(verifyGitHubInstallationForUser("user_1", 42)).resolves.toMatchObject({
      kind: "forbidden",
      reason: "missing-user-token",
    });
    expect(h.ghFetch).not.toHaveBeenCalled();
    expect(h.appFetch).not.toHaveBeenCalled();
  });

  it("rejects an installation id the initiating user cannot access", async () => {
    h.ghFetch.mockResolvedValue({ total_count: 0, installations: [] });

    await expect(verifyGitHubInstallationForUser("user_1", 42)).resolves.toMatchObject({
      kind: "forbidden",
      reason: "not-user-accessible",
    });
    expect(h.appFetch).not.toHaveBeenCalled();
  });

  it("checks later pages of the user's installation list", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      ...installation,
      id: index + 1_000,
    }));
    h.ghFetch
      .mockResolvedValueOnce({ total_count: 101, installations: page })
      .mockResolvedValueOnce({ total_count: 101, installations: [installation] });

    await expect(verifyGitHubInstallationForUser("user_1", 42)).resolves.toEqual({
      kind: "ok",
      installation,
    });
    expect(h.ghFetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of looping on a malformed GitHub pagination response", async () => {
    h.ghFetch.mockResolvedValue({ installations: Array(100).fill(installation) });

    await expect(verifyGitHubInstallationForUser("user_1", 999)).rejects.toThrow(
      "invalid installation count",
    );
    expect(h.ghFetch).toHaveBeenCalledTimes(1);
    expect(h.appFetch).not.toHaveBeenCalled();
  });

  it("rejects disagreement between the user-token and App-JWT installations", async () => {
    h.appFetch.mockResolvedValue({
      ...installation,
      account: { ...installation.account, id: 701 },
    });

    await expect(verifyGitHubInstallationForUser("user_1", 42)).resolves.toMatchObject({
      kind: "forbidden",
      reason: "app-mismatch",
    });
  });

  it("rejects an installation belonging to a different GitHub App", async () => {
    h.appFetch.mockResolvedValue({ ...installation, app_id: 10 });

    await expect(verifyGitHubInstallationForUser("user_1", 42)).resolves.toMatchObject({
      kind: "forbidden",
      reason: "app-mismatch",
    });
  });

  it("returns only canonical App-JWT metadata after both checks agree", async () => {
    await expect(verifyGitHubInstallationForUser("user_1", 42)).resolves.toEqual({
      kind: "ok",
      installation,
    });
    expect(h.appFetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/42",
    );
  });
});
