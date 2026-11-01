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
import { CloudHomePlanCard } from "@/components/billing/CloudHomePlanCard";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deployment.mockResolvedValue({ selfHosted: false, deployMode: "docker" });
  mocks.productView.mockResolvedValue("platform");
  mocks.home.mockResolvedValue({ projects: [] });
});

describe("home Cloud billing boundary", () => {
  it.each([
    { selfHosted: true, deployMode: "docker" },
    { selfHosted: true, deployMode: "desktop" },
    { selfHosted: false, deployMode: "desktop" },
    null,
  ])("never mounts or fetches the offer outside the hosted Cloud dashboard: %j", async deployment => {
    mocks.deployment.mockResolvedValue(deployment);
    const page = await DashboardHome();
    expect(page.props.planCard).toBeNull();
    expect(mocks.billing).not.toHaveBeenCalled();
  });

  it("keeps the mail home outside project and billing reads", async () => {
    mocks.productView.mockResolvedValue("mail");
    await DashboardHome();
    expect(mocks.home).not.toHaveBeenCalled();
    expect(mocks.billing).not.toHaveBeenCalled();
  });

  it("loads billing in its own Suspense slot without blocking the home payload", async () => {
    const state = { tier: "free", subscription: null, billing: { enabled: true } };
    mocks.billing.mockResolvedValue({ kind: "ok", state });
    const page = await DashboardHome();
    expect(page.props.initialData).toEqual({ projects: [] });
    expect(page.props.planCard.props.fallback).toBeNull();
    expect(mocks.billing).not.toHaveBeenCalled();
    const slot = page.props.planCard.props.children;
    const card = await slot.type();
    expect(card.type).toBe(CloudHomePlanCard);
    expect(card.props.state).toBe(state);
    expect(mocks.billing).toHaveBeenCalledOnce();
  });

  it("hides the card for a workspace member without billing access", async () => {
    mocks.billing.mockResolvedValue({ kind: "unavailable", reason: "billing-forbidden" });
    const page = await DashboardHome();
    const slot = page.props.planCard.props.children;
    expect(await slot.type()).toBeNull();
  });

  it("hides the card when billing cannot confirm that this is a new customer", async () => {
    mocks.billing.mockResolvedValue({ kind: "unavailable", reason: "billing-unreachable" });
    const page = await DashboardHome();
    const slot = page.props.planCard.props.children;
    expect(await slot.type()).toBeNull();
  });
});
