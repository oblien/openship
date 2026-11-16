import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deployment: vi.fn(),
  productView: vi.fn(),
  home: vi.fn(),
  billing: vi.fn(),
}));
vi.mock("@/lib/server/session", () => ({ getDeploymentInfoOrNull: mocks.deployment }));
vi.mock("@/lib/server/product-view", () => ({ resolveRequestProductView: mocks.productView }));
vi.mock("@/lib/server/api", () => ({ serverApi: { get: mocks.home } }));
vi.mock("./billing/_components/billing-state", () => ({ getBillingPageState: mocks.billing }));
vi.mock("./emails/_components/mail-console", () => ({ MailConsole: () => null }));
vi.mock("./DashboardHomeClient", () => ({ default: () => null }));

import DashboardHome from "./page";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deployment.mockResolvedValue({ selfHosted: false, deployMode: "docker" });
  mocks.productView.mockResolvedValue("platform");
  mocks.home.mockResolvedValue({ projects: [] });
});

describe("dashboard home data boundary", () => {
  it.each([
    { selfHosted: false, deployMode: "docker" },
    { selfHosted: true, deployMode: "docker" },
    { selfHosted: true, deployMode: "desktop" },
    { selfHosted: false, deployMode: "desktop" },
    null,
  ])(
    "loads the same activity data without billing in every deployment mode: %j",
    async (deployment) => {
      mocks.deployment.mockResolvedValue(deployment);
      const page = await DashboardHome();
      expect(page.props).toEqual({ initialData: { projects: [] } });
      expect(mocks.home).toHaveBeenCalledWith("projects/home", { cache: "no-store" });
      expect(mocks.billing).not.toHaveBeenCalled();
    },
  );

  it("keeps the mail home outside project and billing reads", async () => {
    mocks.productView.mockResolvedValue("mail");
    await DashboardHome();
    expect(mocks.home).not.toHaveBeenCalled();
    expect(mocks.billing).not.toHaveBeenCalled();
  });
});
