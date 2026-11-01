import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ deployment: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getDeploymentInfoOrNull: h.deployment }));
vi.mock("@/components/api-unavailable", () => ({ ApiUnavailable: () => null }));
vi.mock("@/components/support/SupportCenter", () => ({ SupportCenter: () => null }));
import SupportPage from "./page";
import { SupportCenter } from "@/components/support/SupportCenter";
import { ApiUnavailable } from "@/components/api-unavailable";

beforeEach(() => vi.resetAllMocks());
it("renders the private ticket center on Cloud", async () => {
  h.deployment.mockResolvedValue({ selfHosted: false, deployMode: "docker" });
  expect((await SupportPage()).type).toBe(SupportCenter);
});
it.each([
  { selfHosted: true, deployMode: "docker", authMode: "none" },
  { selfHosted: true, deployMode: "docker", authMode: "cloud" },
  { selfHosted: false, deployMode: "desktop", authMode: "cloud" },
])(
  "lets the support center resolve the linked account on $deployMode with selfHosted=$selfHosted",
  async (deployment) => {
    h.deployment.mockResolvedValue(deployment);
    expect((await SupportPage()).type).toBe(SupportCenter);
  },
);
it("does not assume Cloud when deployment information is unavailable", async () => {
  h.deployment.mockResolvedValue(null);
  expect((await SupportPage()).type).toBe(ApiUnavailable);
});
