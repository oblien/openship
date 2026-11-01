import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/platform/engine/config/env", () => ({
  // Deliberately invalid for Cloud. The real env module rejects this at boot;
  // the resolver must still fail closed if it receives such configuration.
  env: {
    CLOUD_MODE: true,
    GITHUB_AUTH_MODE: "oauth",
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "openship-io",
  },
  localGitHubAppConfiguration: { configured: false, intended: false, missing: [] },
}));
vi.mock("@repo/db", () => ({
  repos: {},
  db: {},
  schema: {},
  eq: vi.fn(),
  and: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({ cacheStore: vi.fn() }));
vi.mock("@repo/platform/engine/lib/org-actor", () => ({ resolveOrgOwner: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.http", () => ({
  ghFetch: vi.fn(),
  ghFetchPublic: vi.fn(),
  ghFetchSoft: vi.fn(),
}));

import { getGitHubAuthMode, resolveGitHubAuthMode } from "@repo/platform/engine/modules/github/github.auth";

describe("Cloud GitHub auth mode", () => {
  it("cannot be switched away from the canonical Openship App", async () => {
    expect(getGitHubAuthMode()).toBe("app");
    await expect(resolveGitHubAuthMode({
      userId: "user_1",
      organizationId: "org_1",
    } as any)).resolves.toBe("app");
  });
});
