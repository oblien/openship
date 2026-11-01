// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: "",
  router: { push: vi.fn(), replace: vi.fn() },
  list: vi.fn(),
  setActive: vi.fn(),
  full: vi.fn(),
  signOut: vi.fn(),
  active: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => h.router,
  useSearchParams: () => new URLSearchParams(h.query),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    organization: { list: h.list, setActive: h.setActive, getFullOrganization: h.full },
  },
  signOut: h.signOut,
}));
vi.mock("@/lib/api/client", () => ({ setActiveOrganizationId: h.active }));
vi.mock("@/components/auth-shell", () => ({
  AuthShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
import SelectOrganizationPage from "./page";

let root: Root;
let container: HTMLDivElement;
const destination = "/apps/new/convex?projectId=proj_draft";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.query = new URLSearchParams({ returnTo: destination }).toString();
  h.list.mockResolvedValue({ data: [{ id: "org_one", name: "Personal" }] });
  h.setActive.mockResolvedValue({});
  h.full.mockImplementation(async ({ organizationId }: { organizationId: string }) => ({
    data: { id: organizationId, members: [] },
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<SelectOrganizationPage />));
const click = (text: string) =>
  act(async () => {
    const button = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes(text),
    );
    expect(button).toBeDefined();
    button!.click();
  });

it("continues to the app after the only workspace is activated", async () => {
  await render();
  expect(h.router.replace).toHaveBeenCalledWith(destination);
  expect(h.active).toHaveBeenCalledWith("org_one");
});

it("shows a failed workspace activation instead of losing the app in a redirect", async () => {
  h.setActive.mockResolvedValue({ error: { message: "Could not activate workspace" } });
  await render();
  expect(container.textContent).toContain("Could not activate workspace");
  expect(h.router.replace).not.toHaveBeenCalled();
  expect(h.active).not.toHaveBeenCalled();
});

it("continues to the selected app after choosing among workspaces", async () => {
  h.list.mockResolvedValue({
    data: [
      { id: "org_one", name: "Personal" },
      { id: "org_two", name: "Team" },
    ],
  });
  await render();
  expect(h.router.push).not.toHaveBeenCalled();
  await click("Team");
  expect(h.active).toHaveBeenCalledWith("org_two");
  expect(h.router.push).toHaveBeenCalledWith(destination);
});

it("never follows an external continuation", async () => {
  h.query = new URLSearchParams({ returnTo: "//evil.test/apps/new/convex" }).toString();
  await render();
  expect(h.router.replace).toHaveBeenCalledWith("/");
});
