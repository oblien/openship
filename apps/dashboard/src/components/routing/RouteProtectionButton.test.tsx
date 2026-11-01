// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RouteProtectionButton } from "./RouteProtectionButton";
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

it("does not call a failed status read public, and supports retry without leaving the dialog", async () => {
  api.listRouteProtection.mockRejectedValue(new Error("offline"));
  await act(async () =>
    root.render(<RouteProtectionButton hostname="private.test" projectId="proj" />),
  );
  await act(async () => container.querySelector("button")!.click());
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
    root.render(<RouteProtectionButton hostname="private.test" projectId="proj" />),
  );
  await act(async () => container.querySelector("button")!.click());
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
  });
  expect(api.changeRouteProtection).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
});
