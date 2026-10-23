// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import DomainBodyLimit from "./DomainBodyLimit";

const h = vi.hoisted(() => ({ get: vi.fn(), edge: vi.fn(), update: vi.fn() }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/lib/api/domains", () => ({ domainsApi: { get: h.get, update: h.update } }));
vi.mock("@/lib/api/projects", () => ({ projectsApi: { getEdgeConfig: h.edge } }));
// Shared dropdown keyboard/portal behavior has its own suite. Keep this suite
// focused on the domain's inheritance choices and save/read-back lifecycle.
vi.mock("@/components/ui/CustomSelect", () => ({
  CustomSelect: ({ value, options, onChange, ...props }: any) => (
    <select
      aria-label={props["aria-label"]}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={props.disabled}
    >
      {options.map((option: any) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
let container: HTMLDivElement, root: Root;
const bodyLimit = {
  saved: { clientMaxBodySize: "0" },
  effective: "0",
  source: "domain",
  observed: "1m",
  applied: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.get.mockResolvedValue({ data: { proxy: { clientMaxBodySize: "0" } } });
  h.edge.mockResolvedValue({
    reachable: true,
    hosts: [{ hostname: "app.example.com", bodyLimit }],
  });
  h.update.mockResolvedValue({ data: {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(node?: ReactNode) {
  await act(async () =>
    root.render(
      node ?? (
        <DomainBodyLimit
          domainId="domain-a"
          hostname="app.example.com"
          projectId="project-a"
          supported
        />
      ),
    ),
  );
}
async function open() {
  await act(async () => {
    const details = container.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((row) => row.textContent === text)!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}

describe("per-domain HTTP body editor", () => {
  it("labels unlimited explicitly and shows observed drift instead of treating saved as applied", async () => {
    await render();
    expect(h.edge).not.toHaveBeenCalled();
    await open();
    expect(container.textContent).toContain("Unlimited (0)");
    expect(container.textContent).toContain("Not applied — retry routing");
    expect(container.textContent).toContain("1m");
    expect(container.textContent).toContain("WebSocket");
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("0");
    await click("Save");
    expect(h.update).toHaveBeenCalledWith("domain-a", { proxy: { clientMaxBodySize: "0" } });
    expect(container.textContent).toContain("Not applied — retry routing");
  });
  it("clears the override with null when inheriting the project", async () => {
    await render();
    await open();
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "inherit";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("input")).toBeNull();
    h.get.mockResolvedValue({ data: { proxy: null } });
    h.edge.mockResolvedValue({
      hosts: [
        {
          hostname: "app.example.com",
          bodyLimit: {
            saved: null,
            effective: "5m",
            source: "project",
            observed: "5m",
            applied: true,
          },
        },
      ],
    });
    await click("Save");
    expect(h.update).toHaveBeenCalledWith("domain-a", { proxy: null });
    expect(container.textContent).toContain("Applied");
    expect(container.textContent).toContain("5m");
    expect(container.textContent).toContain("Project");
  });
  it("refreshes saved and live state after apply failure while keeping the failure visible", async () => {
    await render();
    await open();
    h.update.mockRejectedValue(new Error("Saved, but reload failed"));
    const reads = h.edge.mock.calls.length;
    await click("Save");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("reload failed");
    expect(h.edge).toHaveBeenCalledTimes(reads + 1);
    expect(container.textContent).toContain("Not applied — retry routing");
  });
  it("keeps a saved custom limit visible when live application cannot be observed", async () => {
    h.edge.mockResolvedValue({
      reachable: false,
      hosts: [
        {
          hostname: "app.example.com",
          bodyLimit: {
            saved: { clientMaxBodySize: "0" },
            effective: null,
            source: "domain",
            observed: null,
            applied: null,
          },
        },
      ],
    });
    await render();
    await open();
    expect(container.textContent).toContain("Unlimited (0)");
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).not.toContain("Not applied");
    expect(container.textContent).not.toContain("Applied");
  });
  it.each(["25", "1m;return 200", " 1m", "99999999999999999999999999g"])(
    "blocks invalid or overflow input %j before saving",
    async (value) => {
      await render();
      await open();
      await act(async () => {
        const input = container.querySelector("input")!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.querySelector('[aria-invalid="true"]')).not.toBeNull();
      await click("Save");
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it("explains unsupported targets without offering to save", async () => {
    await render(
      <DomainBodyLimit
        domainId="domain-a"
        hostname="app.example.com"
        projectId="project-a"
        supported={false}
      />,
    );
    await open();
    expect(container.textContent).toContain("Requires a self-hosted nginx/OpenResty edge");
    expect(container.querySelector("button")).toBeNull();
    expect(h.get).not.toHaveBeenCalled();
  });
});
