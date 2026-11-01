import { beforeEach, expect, it, vi } from "vitest";
import Page from "./page";
import { validateReturnTo } from "@/lib/cloud-auth";

const h = vi.hoisted(() => ({ session: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getSession: h.session }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/components/billing/CloudBillingLink", () => ({ CloudBillingLink: () => null }));
beforeEach(() => {
  h.session.mockReset();
  h.redirect.mockReset().mockImplementation(() => {
    throw new Error("redirect");
  });
});

it("preserves the organization and top-up destination when an email is opened while signed out", async () => {
  h.session.mockResolvedValue(null);
  await expect(
    Page({ searchParams: Promise.resolve({ organizationId: "org-one", tab: "topups" }) }),
  ).rejects.toThrow("redirect");
  const login = new URL(h.redirect.mock.calls[0][0], "https://dashboard.test");
  expect(login.pathname).toBe("/login");
  expect(validateReturnTo(login.searchParams.get("returnTo"))).toBe(
    "/cloud-billing?organizationId=org-one&tab=topups",
  );
});

it("requires the linked organization to be selected and limits the destination to billing tabs", async () => {
  h.session.mockResolvedValue({ user: { id: "user-one" } });
  const page = await Page({
    searchParams: Promise.resolve({ organizationId: "org-two", tab: "https://evil.test" }),
  });
  expect(page.props).toEqual({ organizationId: "org-two", tab: "overview" });
  expect(h.redirect).not.toHaveBeenCalled();
});
