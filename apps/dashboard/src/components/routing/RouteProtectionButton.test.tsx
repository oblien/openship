// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RouteProtectionButton, RouteProtectionPanel } from "./RouteProtectionButton";
const api = vi.hoisted(() => ({ listRouteProtection: vi.fn(), changeRouteProtection: vi.fn() }));
vi.mock("@/lib/api", () => ({
  projectsApi: api,
  getApiErrorMessage: (_: unknown, fallback: string) => fallback,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listRouteProtection.mockResolvedValue({ data: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.includes(text) || b.getAttribute("aria-label")?.includes(text),
  );
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}

it("does not call a failed status read public, and supports retry in Access", async () => {
  api.listRouteProtection.mockRejectedValue(new Error("offline"));
  await act(async () =>
    root.render(<RouteProtectionPanel hostname="private.test" projectId="proj" />),
  );
  expect(document.body.textContent).toContain("Protection status could not be checked");
  expect(document.body.textContent).not.toContain("Anyone can");
  api.listRouteProtection.mockResolvedValue({
    data: [{ hostname: "private.test", enabled: true, status: "applied" }],
  });
  await click("Retry");
  expect(document.body.textContent).toContain("Sign everyone out");
  expect(api.changeRouteProtection).not.toHaveBeenCalled();
});

it("requires explicit confirmation to make a protected route public", async () => {
  api.listRouteProtection.mockResolvedValue({
    data: [{ hostname: "private.test", enabled: true, status: "applied" }],
  });
  api.changeRouteProtection.mockResolvedValue({
    data: { hostname: "private.test", enabled: false, status: "applied" },
  });
  await act(async () =>
    root.render(<RouteProtectionPanel hostname="private.test" projectId="proj" />),
  );
  await click("Remove protection");
  expect(api.changeRouteProtection).not.toHaveBeenCalled();
  await click("Make public");
  expect(api.changeRouteProtection).toHaveBeenCalledWith("proj", {
    hostname: "private.test",
    action: "unlock",
  });
});

it("stages a new wizard password in memory and clears the editor after saving", async () => {
  const stage = vi.fn();
  await act(async () =>
    root.render(<RouteProtectionButton hostname="private.test" onDraftChange={stage} />),
  );
  await act(async () => container.querySelector("button")!.click());
  const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "private-wizard-password",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(stage).toHaveBeenCalledWith({
    hostname: "private.test",
    action: "protect",
    password: "private-wizard-password",
    options: { mode: "page", username: "visitor", sessionSeconds: 86400, loginHtml: undefined },
  });
  expect(api.changeRouteProtection).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
});

it("changes authentication inline without re-entering a password and shows pending state", async () => {
  api.listRouteProtection.mockResolvedValue({
    data: [
      {
        hostname: "private.test",
        enabled: true,
        status: "applied",
        options: { mode: "page", sessionSeconds: 86400 },
      },
    ],
  });
  api.changeRouteProtection.mockResolvedValue({
    data: {
      hostname: "private.test",
      enabled: true,
      status: "pending",
      options: { mode: "basic", username: "viewer", sessionSeconds: 86400 },
    },
  });
  await act(async () =>
    root.render(<RouteProtectionPanel hostname="private.test" projectId="proj" />),
  );
  expect(container.querySelector('[role="status"]')?.className).toContain("text-success");
  await click("Browser authentication");
  expect(document.body.textContent).not.toContain("Sign everyone out");
  const username = document.querySelector<HTMLInputElement>("input[pattern]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      username,
      "viewer",
    );
    username.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save protection");
  expect(api.changeRouteProtection).toHaveBeenCalledWith("proj", {
    hostname: "private.test",
    action: "configure",
    options: { mode: "basic", username: "viewer", sessionSeconds: 86400, loginHtml: undefined },
  });
  expect(container.querySelector('[role="status"]')?.className).not.toContain("text-success");
  expect(container.querySelector('[role="status"]')?.className).toContain("text-warning");
});

it.each([
  ["applied", "text-success"],
  ["pending", "text-warning"],
])("links the %s lock to its hostname in Access", async (status, color) => {
  api.listRouteProtection.mockResolvedValue({
    data: [{ hostname: "private.test", enabled: true, status }],
  });
  await act(async () =>
    root.render(<RouteProtectionButton hostname="private.test" projectId="proj" />),
  );
  const link = container.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("/projects/proj/access?hostname=private.test");
  expect(link.className).toContain(color);
  expect(link.getAttribute("aria-label")).toContain("private.test");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps the wizard editor in place with custom HTML and clears it when disabled", async () => {
  const stage = vi.fn();
  await act(async () =>
    root.render(<RouteProtectionButton hostname="new.test" onDraftChange={stage} />),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  const html = document.querySelector("textarea")!;
  expect(html.value).toContain("{{form}}");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  expect(document.querySelector("textarea")).toBeNull();
  expect(api.changeRouteProtection).not.toHaveBeenCalled();
});
