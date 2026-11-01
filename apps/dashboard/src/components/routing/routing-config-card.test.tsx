// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RoutingConfig } from "@repo/core";
import type { EdgeConfigReport } from "@/lib/api/projects";
import { I18nProvider } from "@/components/i18n-provider";
import { RoutingConfigCard } from "@/app/(dashboard)/projects/[id]/components/RoutingConfigCard";

const mocks = vi.hoisted(() => ({
  getEdgeConfig: vi.fn(),
  update: vi.fn(),
  invalidate: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  projectsApi: { getEdgeConfig: mocks.getEdgeConfig, update: mocks.update },
  getApiErrorMessage: () => "Save failed",
}));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: mocks.invalidate }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function render(
  id: string,
  initial: RoutingConfig | null,
  onSaved = vi.fn(),
  isCloudProject = false,
) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <RoutingConfigCard
          id={id}
          initial={initial}
          onSaved={onSaved}
          isCloudProject={isCloudProject}
        />
      </I18nProvider>,
    ),
  );
}
function button(label: string) {
  const element = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
  expect(element, label).toBeDefined();
  return element!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function upload() {
  const label = Array.from(container.querySelectorAll("label")).find(
    (l) => l.textContent === "Upload size limit",
  )!;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
}
async function fillUpload(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      upload(),
      value,
    );
    upload().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function report(hostname: string): EdgeConfigReport {
  return {
    reachable: true,
    saved: {},
    hosts: [{ hostname, found: true, tls: true, directives: [], adoptable: {}, driftCount: 0 }],
  };
}

it("shows groups without automatic host readback; refresh is explicit", async () => {
  await render("project-a", null);
  expect(container.textContent).toContain("Uploads");
  expect(container.textContent).toContain("TLS to the app");
  expect(mocks.getEdgeConfig).not.toHaveBeenCalled();
  mocks.getEdgeConfig.mockResolvedValue(report("a.example.com"));
  await click("Re-read the live config");
  expect(mocks.getEdgeConfig).toHaveBeenCalledExactlyOnceWith("project-a");
  expect(container.textContent).toContain("a.example.com");
});

it("resets a draft on project switch and ignores the previous project's late readback", async () => {
  const pending = deferred<EdgeConfigReport>();
  mocks.getEdgeConfig
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(report("b.example.com"));
  await render("project-a", { proxy: { clientMaxBodySize: "10m" } });
  await fillUpload("25m");
  await click("Re-read the live config");
  await render("project-b", { proxy: { clientMaxBodySize: "50m" } });
  expect(upload().value).toBe("50m");
  expect(mocks.getEdgeConfig).toHaveBeenCalledTimes(1);
  await click("Re-read the live config");
  await act(async () => pending.resolve(report("a.example.com")));
  expect(container.textContent).toContain("b.example.com");
  expect(container.textContent).not.toContain("a.example.com");
});

it("keeps unsaved edits across refreshed initial props and saves the exact draft without SSH", async () => {
  const onSaved = vi.fn();
  await render("project-a", { proxy: { clientMaxBodySize: "10m", gzip: false } }, onSaved);
  await fillUpload("25m");
  await render("project-a", { proxy: { clientMaxBodySize: "10m", gzip: false } }, onSaved);
  expect(upload().value).toBe("25m");
  await click("Save");
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith("project-a", {
    routingConfig: { proxy: { clientMaxBodySize: "25m", gzip: false } },
  });
  expect(onSaved).toHaveBeenCalledWith({ proxy: { clientMaxBodySize: "25m", gzip: false } });
  expect(mocks.getEdgeConfig).not.toHaveBeenCalled();
});

it("fences readback started before save", async () => {
  const pending = deferred<EdgeConfigReport>();
  mocks.getEdgeConfig.mockReturnValueOnce(pending.promise);
  await render("project-a", null);
  await click("Re-read the live config");
  await fillUpload("25m");
  await click("Save");
  await act(async () => pending.resolve(report("stale.example.com")));
  expect(container.textContent).not.toContain("stale.example.com");
  expect(button("Re-read the live config").disabled).toBe(false);
});

it("does not publish a previous project's late save into the new project", async () => {
  const pending = deferred<void>();
  const onSaved = vi.fn();
  mocks.update.mockReturnValueOnce(pending.promise);
  await render("project-a", { proxy: { clientMaxBodySize: "25m" } }, onSaved);
  await click("Save");
  await render("project-b", { proxy: { clientMaxBodySize: "50m" } }, onSaved);
  await act(async () => pending.resolve());
  expect(upload().value).toBe("50m");
  expect(onSaved).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("project-a");
});

it("hides unsupported Cloud proxy controls and readback while retaining routing controls", async () => {
  await render("cloud-project", null, vi.fn(), true);
  expect(container.textContent).toContain("Proxy settings are unavailable for Cloud projects");
  for (const label of ["Rewrites", "Redirects", "Response headers", "URL behavior"]) {
    expect(container.querySelector(`section[aria-label="${label}"]`)).not.toBeNull();
  }
  expect(container.textContent).not.toContain("Upload size limit");
  expect(container.querySelector('[aria-label="Re-read the live config"]')).toBeNull();
  expect(mocks.getEdgeConfig).not.toHaveBeenCalled();
});

it("preserves saved proxy values when saving other routing edits on Cloud", async () => {
  const proxy = { clientMaxBodySize: "25m", gzip: false };
  await render("cloud-project", { proxy, trailingSlash: false }, vi.fn(), true);
  await click("Hide .html extensions");
  await click("Save");
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith("cloud-project", {
    routingConfig: { proxy, trailingSlash: false, cleanUrls: true },
  });
  expect(mocks.getEdgeConfig).not.toHaveBeenCalled();
});

it("uses the project target when switching from Cloud to a linked self-hosted project", async () => {
  await render("cloud-project", null, vi.fn(), true);
  await render("linked-server-project", { proxy: { clientMaxBodySize: "25m" } }, vi.fn(), false);
  expect(upload().value).toBe("25m");
  expect(container.textContent).not.toContain("Proxy settings are unavailable for Cloud projects");
  mocks.getEdgeConfig.mockResolvedValue(report("linked.example.com"));
  await click("Re-read the live config");
  expect(mocks.getEdgeConfig).toHaveBeenCalledExactlyOnceWith("linked-server-project");
});
