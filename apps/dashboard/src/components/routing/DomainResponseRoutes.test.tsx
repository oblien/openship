// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeEdgeResponse } from "@repo/core";
import { DomainResponseRoutes } from "./DomainResponseRoutes";

const api = vi.hoisted(() => ({
  listRouteRules: vi.fn(),
  createRouteRule: vi.fn(),
  updateRouteRule: vi.fn(),
  deleteRouteRule: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  projectsApi: api,
  getApiErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
let root: Root;
let container: HTMLDivElement;
const rule = (overrides = {}) => ({
  id: "response-a",
  projectId: "project",
  domainId: "domain-a",
  pathPrefix: "/x",
  enabled: true,
  spec: {
    response: normalizeEdgeResponse({ body: "original", headers: { "cache-control": "no-store" } }),
  },
  ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listRouteRules.mockResolvedValue({ rules: [] });
  api.createRouteRule.mockImplementation(async (_project, input) => ({
    rule: rule({ ...input, edgeApplied: true }),
  }));
  api.updateRouteRule.mockImplementation(async (_project, _id, input) => ({
    rule: rule({ ...input, edgeApplied: true }),
  }));
  api.deleteRouteRule.mockResolvedValue({ success: true, edgeApplied: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <DomainResponseRoutes projectId="project" domainId="domain-a" hostname="app.test" />,
    ),
  );
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
  );
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
async function input(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  expect(element, selector).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it("creates a response for this domain, keeps preview HTML inert, and reports edge acknowledgement", async () => {
  await render();
  await click("Add route");
  await input('input[placeholder="/health"]', "/status");
  await input("textarea", "<script>window.injected = true</script>");
  await click("Add header");
  await input('input[aria-label="Header name 1"]', "Cache-Control");
  await input('input[aria-label="Header value 1"]', "no-store");
  await click("Response preview");
  expect(document.querySelector("pre")?.textContent).toContain("<script>");
  expect(document.querySelector("pre script")).toBeNull();
  await submit();
  expect(api.createRouteRule).toHaveBeenCalledWith(
    "project",
    expect.objectContaining({
      domainId: "domain-a",
      pathPrefix: "/status",
      enabled: true,
      spec: {
        response: expect.objectContaining({
          body: "<script>window.injected = true</script>",
          headers: { "cache-control": "no-store" },
          match: "exact",
        }),
      },
    }),
  );
  expect(document.body.textContent).toContain("Saved and applied to the edge.");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("retains a failed draft, avoids double submit and distinguishes saved from applied", async () => {
  await render();
  await click("Add route");
  await input('input[placeholder="/health"]', "/x");
  await input("textarea", "keep this content");
  let reject!: (error: Error) => void;
  api.createRouteRule.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await submit();
  await submit();
  expect(api.createRouteRule).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("offline")));
  expect(document.querySelector("textarea")?.value).toBe("keep this content");
  expect(document.body.textContent).toContain("offline");
  api.createRouteRule.mockResolvedValue({ rule: rule({ edgeApplied: false }) });
  await submit();
  expect(document.body.textContent).toContain("Edge application is pending");
  expect(document.body.textContent).not.toContain("Saved and applied");
});

it("rejects duplicate or injected headers before sending a mutation", async () => {
  await render();
  await click("Add route");
  await input('input[placeholder="/health"]', "/headers");
  for (const [index, name] of ["X-Test", "x-test"].entries()) {
    await click("Add header");
    await input(`input[aria-label="Header name ${index + 1}"]`, name);
  }
  await submit();
  expect(api.createRouteRule).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("must be unique");
});

it("edits only the selected domain response and preserves its disabled state", async () => {
  api.listRouteRules.mockResolvedValue({
    rules: [
      rule({ enabled: false }),
      rule({ id: "other", domainId: "domain-b", pathPrefix: "/other-domain" }),
      rule({ id: "policy", spec: { rateLimit: { rps: 5, burst: 0 } } }),
    ],
  });
  await render();
  expect(container.textContent).not.toContain("/other-domain");
  await click("Edit route /x");
  expect(document.querySelector("textarea")?.value).toBe("original");
  await input("textarea", "changed");
  await submit();
  const patch = api.updateRouteRule.mock.calls[0]![2];
  expect(patch).not.toHaveProperty("enabled");
  expect(patch.spec.response).toMatchObject({
    body: "changed",
    headers: { "cache-control": "no-store" },
  });
  expect(api.createRouteRule).not.toHaveBeenCalled();
});

it("keeps failed loading distinct from an empty list and requires confirmation to remove", async () => {
  api.listRouteRules.mockRejectedValueOnce(new Error("Cannot reach API"));
  await render();
  expect(container.textContent).toContain("Cannot reach API");
  expect(
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add route"),
    )?.disabled,
  ).toBe(true);
  api.listRouteRules.mockResolvedValue({ rules: [rule()] });
  await click("Retry");
  await click("Remove /x");
  expect(api.deleteRouteRule).not.toHaveBeenCalled();
  await click("Remove");
  expect(api.deleteRouteRule).toHaveBeenCalledWith("project", "response-a");
  expect(container.textContent).not.toContain("/x");
});
