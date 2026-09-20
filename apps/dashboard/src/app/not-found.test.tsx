import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getDeploymentInfo: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  getSession: mocks.getSession,
  getDeploymentInfo: mocks.getDeploymentInfo,
}));
vi.mock("@/lib/server/api", () => ({ serverApi: { get: mocks.get } }));
vi.mock("@/components/auth-shell", () => ({ AuthShell: "auth-shell" }));
vi.mock("@/components/sidebar", () => ({ Sidebar: "dashboard-sidebar" }));
vi.mock("@/components/not-found-content", () => ({ NotFoundContent: "not-found-content" }));
vi.mock("./(dashboard)/providers", () => ({ DashboardProviders: "dashboard-providers" }));

import NotFound from "./not-found";

describe("authenticated global not-found shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getDeploymentInfo.mockResolvedValue({
      selfHosted: true,
      deployMode: "docker",
      authMode: "local",
      version: "0.6.9",
      cloudAuthUrl: "https://cloud.example.test",
      cloudApiUrl: "https://api.example.test",
    });
    mocks.get.mockResolvedValue(null);
  });

  it("forwards the server release to dashboard chrome", async () => {
    const page = (await NotFound()) as ReactElement<{ version?: string }>;

    expect(page.props.version).toBe("0.6.9");
  });
});
