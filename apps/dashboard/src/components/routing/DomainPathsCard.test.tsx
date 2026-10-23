// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Service } from "@/lib/api";
import { CloudResourceContext } from "@/context/CloudResourceContext";
import { DomainPathsCard } from "./DomainPathsCard";

const h = vi.hoisted(() => ({ update: vi.fn(), saved: vi.fn() }));
vi.mock("@/lib/api", () => ({ projectsApi: { update: h.update } }));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: vi.fn() }));
const services = [
  {
    id: "web",
    name: "Frontend",
    enabled: true,
    exposedPort: "8080",
    ports: ["8080"],
    exposed: true,
  },
  { id: "api", name: "API", enabled: true, exposedPort: "9000", ports: ["9000"], exposed: false },
] as Service[];
const domains = [
  { id: "domain", hostname: "app.example.com", serviceId: "web" },
  { id: "second", hostname: "second.example.com", serviceId: "web" },
];
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.update.mockReset().mockImplementation(async (_id, body) => ({
    data: {
      compositeRoutes: body.domainRoutes[0].paths.length
        ? [{ hostname: "app.example.com", locations: body.domainRoutes[0].paths }]
        : null,
    },
  }));
  h.saved.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
const click = (label: string) => act(async () => button(label).click());
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Path prefix"]')!;
const fill = (value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
async function render(scope = "account-a") {
  await act(async () =>
    root.render(
      <CloudResourceContext.Provider value={scope}>
        <DomainPathsCard
          projectId="project"
          domains={domains}
          services={services}
          baseDomain="opsh.io"
          onSaved={h.saved}
        />
      </CloudResourceContext.Provider>,
    ),
  );
}
async function chooseDomain(label: string) {
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Domain"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((o) => o.textContent?.includes(label))!
      .click(),
  );
}

it("saves an explicit path to an internal service without changing the root or another hostname", async () => {
  await render();
  await click("Add path");
  await fill("/api");
  expect(document.body.textContent).toContain("/ → Frontend");
  await click("Save");
  expect(h.update).toHaveBeenCalledExactlyOnceWith("project", {
    domainRoutes: [
      { domainId: "domain", paths: [{ pathPrefix: "/api", serviceId: "api", port: 9000 }] },
    ],
  });
  expect(h.saved).toHaveBeenCalledWith({
    compositeRoutes: [
      {
        hostname: "app.example.com",
        locations: [{ pathPrefix: "/api", serviceId: "api", port: 9000 }],
      },
    ],
  });
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Saved");
});

it("keeps unsaved paths per domain and retains them after a rejected save", async () => {
  await render();
  await click("Add path");
  await fill("/api");
  await chooseDomain("second.example.com");
  expect(document.querySelector('input[aria-label="Path prefix"]')).toBeNull();
  await chooseDomain("app.example.com");
  expect(input().value).toBe("/api");
  h.update.mockRejectedValueOnce(new Error("This service was disabled"));
  await click("Save");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "This service was disabled",
  );
  expect(input().value).toBe("/api");
  expect(h.saved).not.toHaveBeenCalled();
});

it("clears only the selected domain and does not apply a late response after an account switch", async () => {
  let finish!: (value: unknown) => void;
  h.update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await click("Save");
  expect(h.update).toHaveBeenCalledWith("project", {
    domainRoutes: [{ domainId: "domain", paths: [] }],
  });
  await render("account-b");
  await click("Add path");
  await fill("/new");
  await act(async () =>
    finish({ data: { compositeRoutes: [{ hostname: "private.old.example" }] } }),
  );
  expect(h.saved).not.toHaveBeenCalled();
  expect(input().value).toBe("/new");
  expect(document.body.textContent).not.toContain("private.old.example");
});

it("does not claim success when an older API silently ignores the new routing field", async () => {
  h.update.mockResolvedValueOnce({ data: { compositeRoutes: null } });
  await render();
  await click("Add path");
  await fill("/api");
  await click("Save");
  expect(h.saved).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("API did not save");
  expect(input().value).toBe("/api");
});
