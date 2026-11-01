import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  headers: new Headers(),
  session: vi.fn(),
  deployment: vi.fn(),
  needsOrgSelection: vi.fn(),
  get: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => h.headers }));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw { redirect: href };
  },
}));
vi.mock("@/lib/server/session", () => ({
  getSession: h.session,
  getDeploymentInfoOrNull: h.deployment,
  getDeploymentInfo: h.deployment,
  needsOrgSelection: h.needsOrgSelection,
}));
vi.mock("@/lib/server/api", () => ({
  serverApi: { get: h.get },
  ServerApiError: class extends Error {},
}));
vi.mock("@/lib/server/product-view", () => ({ resolveRequestProductView: vi.fn() }));
vi.mock("@/app/(dashboard)/providers", () => ({ DashboardProviders: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/app/(auth)/providers", () => ({ AuthProviders: () => null }));
vi.mock("@/components/dashboard-shell", () => ({ DashboardShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/updates/UpdateCenter", () => ({ UpdateCenter: () => null }));
vi.mock("@/components/migrated-launcher", () => ({ MigratedLauncher: () => null }));
vi.mock("@/components/migration-in-progress", () => ({ MigrationInProgress: () => null }));
vi.mock("@/components/instance/InstanceRecovery", () => ({ InstanceRecovery: () => null }));
vi.mock("@/components/api-unavailable", () => ({ ApiUnavailable: () => null }));

vi.mock("@/components/auth-shell", () => ({ AuthShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/not-found-content", () => ({ NotFoundContent: () => <p>Page not found</p> }));

import DashboardLayout from "./(dashboard)/layout";
import NotFound from "./not-found";
import AuthLayout from "./(auth)/layout";

const app = "/apps/new/minio?projectId=proj_draft";
const chooser = `/select-organization?${new URLSearchParams({ returnTo: app })}`;

beforeEach(() => {
  vi.resetAllMocks();
  h.headers = new Headers({
    cookie: "better-auth.session_token=test",
    "x-pathname-with-search": app,
  });
  h.session.mockResolvedValue({ session: { activeOrganizationId: null } });
  h.deployment.mockResolvedValue({ selfHosted: false });
  h.get.mockImplementation(async (path: string) =>
    path === "auth/organization/list" ? [{ id: "org_one" }, { id: "org_two" }] : null,
  );
  h.needsOrgSelection.mockResolvedValue(true);
});

it("preserves an app deep link when a present session cookie has expired", async () => {
  h.session.mockResolvedValue(null);
  await expect(DashboardLayout({ children: null })).rejects.toEqual({
    redirect: `/login?${new URLSearchParams({ returnTo: app })}`,
  });
});

it("carries the selected app to the organization chooser without bouncing back before selection", async () => {
  await expect(DashboardLayout({ children: null })).rejects.toEqual({ redirect: chooser });
  h.headers.set("x-pathname-with-search", chooser);
  await expect(AuthLayout({ children: "Choose a workspace" })).resolves.toBeDefined();
  h.session.mockResolvedValue({ session: { activeOrganizationId: "org_one" } });
  h.needsOrgSelection.mockResolvedValue(false);
  await expect(AuthLayout({ children: null })).rejects.toEqual({ redirect: app });
});

it("returns an already signed-in visitor from login to the selected app", async () => {
  h.headers.set("x-pathname-with-search", `/login?${new URLSearchParams({ returnTo: app })}`);
  await expect(AuthLayout({ children: null })).rejects.toEqual({ redirect: app });
});

it("rejects unsafe continuations even when a session has expired", async () => {
  h.session.mockResolvedValue(null);
  h.headers.set("x-pathname-with-search", "//evil.test/apps/new/minio");
  await expect(DashboardLayout({ children: null })).rejects.toEqual({ redirect: "/login" });
});

it("retains the app if the session expires while choosing an organization", async () => {
  h.session.mockResolvedValue(null);
  h.headers.set("x-pathname-with-search", chooser);
  await expect(AuthLayout({ children: null })).rejects.toEqual({
    redirect: `/login?${new URLSearchParams({ returnTo: app })}`,
  });
});

it.each([
  ["dashboard", () => DashboardLayout({ children: <p>Project list</p> }), "Project list"],
  ["global 404", NotFound, "Page not found"],
] as const)("renders the %s before GitHub home responds", async (_name, render, content) => {
  h.session.mockResolvedValue({ user: { id: "user-1" }, session: { activeOrganizationId: "org_one" } });
  h.get.mockImplementation((path: string) =>
    path === "github/home" ? new Promise(() => {}) : Promise.resolve([{ id: "org_one" }]),
  );
  const html = await Promise.race([
    render().then(renderToStaticMarkup),
    new Promise<string>((resolve) => setImmediate(() => resolve("Waiting for GitHub home"))),
  ]);
  expect(html).toContain(content);
});
