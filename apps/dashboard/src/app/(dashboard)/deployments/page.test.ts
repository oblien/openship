import { expect, it, vi } from "vitest";
import DeploymentsPage from "./page";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));

it("redirects bookmarked deployment filters to Monitoring", async () => {
  await DeploymentsPage({
    searchParams: Promise.resolve({
      status: "failed",
      project: "p1",
      page: "3",
      q: "release & fix",
      tab: "open",
    }),
  });
  const url = new URL(redirect.mock.calls[0][0], "https://openship.io");
  expect(url.pathname).toBe("/monitoring");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    status: "failed",
    project: "p1",
    page: "3",
    q: "release & fix",
    tab: "deployments",
  });
});
