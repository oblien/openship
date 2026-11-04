// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { UpdateCenter } from "./UpdateCenter";
import { SecurityAdvisorySettings } from "@/app/(dashboard)/settings/_components/SecurityAdvisorySettings";
import { SecurityOverviewPanel } from "./SecurityOverviewPanel";

const h = vi.hoisted(() => ({
  account: "account-one",
  updates: vi.fn(),
  push: vi.fn(),
  policy: vi.fn(),
  setPolicy: vi.fn(),
  checksEnabled: true,
  canManage: true,
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user" }, session: {} } }),
}));
vi.mock("@/lib/api/updates", async (original) => ({
  ...(await original<object>()),
  updatesApi: { securityCheckPolicy: h.policy, setSecurityCheckPolicy: h.setPolicy },
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.account }));
vi.mock("@/components/i18n-provider", async (original) => ({
  ...(await original<object>()),
  useI18n: () => ({ t: baseDictionary }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: h.push }) }));
vi.mock("./useUpdates", () => ({ useUpdates: h.updates }));

const copy = baseDictionary.projectSettings.securityAdvisories;
const project = {
  projectId: "esge",
  name: "esge",
  findings: [{ id: "node", evidence: ["node 20.20.2"], serviceName: null, severity: "high" }],
};
const runtime = {
  id: "runtime:node",
  title: "Update Node.js for the Brotli security fix",
  severity: "critical",
  projects: [project],
};
const overview = { projects: [project], pendingProjects: 0, unknownProjects: 0 };
let root: Root;
let container: HTMLDivElement;
function render() {
  root.render(
    <>
      <UpdateCenter />
      <SecurityAdvisorySettings />
    </>,
  );
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.account = "account-one";
  h.checksEnabled = true;
  h.canManage = true;
  h.policy.mockReset().mockImplementation(async () => ({
    data: { checksEnabled: h.checksEnabled, canManage: h.canManage },
  }));
  h.setPolicy.mockReset().mockImplementation(async (enabled) => {
    h.checksEnabled = enabled;
    return { data: { checksEnabled: enabled, canManage: h.canManage } };
  });
  project.findings[0].severity = "high";
  localStorage.clear();
  h.updates.mockReturnValue({
    state: {
      advisories: [
        runtime,
        { id: "maintenance", title: "Scheduled maintenance", severity: "critical" },
      ],
    },
    runtimeAdvisories: [runtime],
    securityOverview: overview,
    desktop: false,
    mode: "cloud",
    refresh: vi.fn(),
    dismissAdvisory: vi.fn(),
    updatePhase: "idle",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each(["high", "critical"] as const)(
  "shows the actual %s severity and saves banner visibility independently of findings",
  async (severity) => {
    project.findings[0].severity = severity;
    await act(async () => render());
    expect(container.textContent).toContain(runtime.title);
    expect(
      [...container.querySelectorAll("span")].some(
        (item) => item.textContent === copy.severity[severity],
      ),
    ).toBe(true);
    await act(async () => button(copy.bannerSettings).click());
    await act(async () => button(copy.hideBanners).click());
    expect(container.textContent).not.toContain(runtime.title);
    expect(container.textContent).toContain("Scheduled maintenance");
    expect(button(copy.showBanners).getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("openship_security_banners:account-one")).toBe("0");
    // Hiding the banner never mutates findings or per-project automatic-update consent.
    expect(h.updates().securityOverview).toBe(overview);
    expect(overview.projects[0].findings).toHaveLength(1);

    await act(async () => root.render(null));
    await act(async () => render());
    expect(container.textContent).not.toContain(runtime.title);
    h.account = "account-two";
    await act(async () => render());
    expect(container.textContent).toContain(runtime.title);
    h.account = "account-one";
    await act(async () => render());
    expect(container.textContent).not.toContain(runtime.title);
    await act(async () => button(copy.showBanners).click());
    expect(container.textContent).toContain(runtime.title);
    expect(localStorage.getItem("openship_security_banners:account-one")).toBe("1");
  },
);

it("shares a visibility change from another browser tab", async () => {
  await act(async () => render());
  const key = "openship_security_banners:account-one";
  await act(async () => {
    localStorage.setItem(key, "0");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "0" }));
  });
  expect(container.textContent).not.toContain(runtime.title);
  expect(button(copy.showBanners).getAttribute("aria-checked")).toBe("false");
});

it("opens a host-only advisory from the root banner and links to server runs", async () => {
  const server = {
    serverId: "host-one",
    name: "Customer host",
    supported: true,
    findings: [
      { id: "host-fix", title: "Kernel update", state: "reboot_required", severity: "high" },
    ],
  };
  const host = {
    id: "runtime:host-fix",
    title: "Kernel update",
    severity: "critical",
    projects: [],
    servers: [server],
  };
  h.updates.mockReturnValue({
    ...h.updates(),
    state: { advisories: [host] },
    runtimeAdvisories: [host],
    securityOverview: { projects: [], servers: [server], pendingProjects: 0, unknownProjects: 0 },
  });
  await act(async () => render());
  expect(container.textContent).toContain("Customer host");
  await act(async () =>
    button(
      baseDictionary.projectSettings.hostSecurity.reviewResources.replace("{count}", "1"),
    ).click(),
  );
  expect(document.querySelector('a[href="/servers/host-one?tab=runs"]')).not.toBeNull();
});

it("saves inspection policy on the server and restores it on remount", async () => {
  await act(async () => render());
  await act(async () => button(copy.checksEnabled).click());
  expect(h.setPolicy).toHaveBeenCalledExactlyOnceWith(false);
  expect(button(copy.checksEnabled).getAttribute("aria-checked")).toBe("false");
  expect(button(copy.showBanners).getAttribute("aria-checked")).toBe("true");
  await act(async () => root.render(null));
  await act(async () => render());
  expect(button(copy.checksEnabled).getAttribute("aria-checked")).toBe("false");
});

it("keeps the saved setting when the server rejects a change", async () => {
  h.setPolicy.mockRejectedValueOnce(new Error("Could not save policy"));
  await act(async () => render());
  await act(async () => button(copy.checksEnabled).click());
  expect(container.textContent).toContain("Could not save policy");
  expect(button(copy.checksEnabled).getAttribute("aria-checked")).toBe("true");
});

it("disables the workspace control for accounts without management permission", async () => {
  h.canManage = false;
  await act(async () => render());
  expect(button(copy.checksEnabled).disabled).toBe(true);
  await act(async () => button(copy.checksEnabled).click());
  expect(h.setPolicy).not.toHaveBeenCalled();
});

it("shows disabled inspection in Monitoring without claiming a clean scan", async () => {
  await act(async () =>
    root.render(
      <SecurityOverviewPanel
        overview={{ checksEnabled: false, projects: [], pendingProjects: 0, unknownProjects: 0 }}
        onChecked={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain(copy.checksDisabled);
  expect(container.textContent).not.toContain(copy.noMatches);
  expect(container.querySelector('a[href="/settings?tab=notifications"]')).not.toBeNull();
});
