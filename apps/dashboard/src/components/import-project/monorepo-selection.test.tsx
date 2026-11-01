// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";
import { DeploymentContext } from "@/context/DeploymentContext";
import {
  DEFAULT_CONFIG,
  type DeploymentConfig,
  type DeploymentContextType,
} from "@/context/deployment/types";
import { monorepoAppFromScan } from "@/context/deployment/monorepo-config";
import MonorepoApps from "./MonorepoApps";
import { MonorepoDomains } from "./MonorepoDomains";
import { RepositoryAppPicker } from "./RepositoryAppPicker";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const api = vi.hoisted(() => ({ tree: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/api/github", () => ({ githubApi: { getRepoTree: api.tree } }));
vi.mock("@/lib/api/deploy", () => ({ deployApi: { prepare: api.prepare } }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));
vi.mock("@/context/CloudContext", () => ({ useDefaultDomainType: () => "free" }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ baseDomain: "opsh.io", selfHosted: true }),
}));
vi.mock("./ProjectSettings", () => ({ default: () => null }));
vi.mock("./BuildSettings", () => ({ default: () => null }));
vi.mock("./EnvironmentVariables", () => ({ default: () => null }));
vi.mock("@/components/routing/RouteProtectionButton", () => ({
  RouteProtectionButton: () => null,
}));
const scan = {
  id: "apps/web",
  name: "web",
  rootDirectory: "apps/web",
  stack: "vite" as const,
  category: "frontend",
  packageManager: "bun",
  buildImage: "oven/bun:1.3.14",
  installCommand: "bun install",
  buildCommand: "bun run build",
  startCommand: "",
  outputDirectory: "dist",
  productionPaths: [],
  port: 5173,
};
let current: DeploymentConfig;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Harness({
  children,
  count = 2,
  selected = false,
}: {
  children: React.ReactNode;
  count?: number;
  selected?: boolean;
}) {
  const [config, setConfig] = useState<DeploymentConfig>({
    ...DEFAULT_CONFIG,
    owner: "acme",
    repo: "repo",
    branch: "main",
    serverId: "server-pat-host",
    projectName: "repo",
    projectType: "monorepo",
    serviceDeploymentMode: "services",
    monorepoApps: Array.from({ length: count }, (_, i) => ({
      ...monorepoAppFromScan(
        { ...scan, id: `apps/app${i}`, rootDirectory: `apps/app${i}`, name: `app${i}` },
        "repo",
        "free",
      ),
      enabled: selected,
    })),
  });
  current = config;
  return (
    <DeploymentContext.Provider
      value={
        {
          config,
          updateConfig: (updates) => setConfig((prev) => ({ ...prev, ...updates })),
        } as DeploymentContextType
      }
    >
      <ModalProvider>{children}</ModalProvider>
    </DeploymentContext.Provider>
  );
}
async function render(children: React.ReactNode, options = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness {...options}>{children}</Harness>));
}
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.clearAllMocks();
});
describe("monorepo selection UI", () => {
  it("requires an explicit selection and lets cancellation leave the app list intact", async () => {
    await render(<MonorepoApps />);
    expect(current.monorepoApps?.some((app) => app.enabled)).toBe(false);
    await click("Choose apps");
    const check = document.querySelector('[aria-label="app0"]') as HTMLButtonElement;
    await act(async () => check.click());
    await click("Cancel");
    expect(current.monorepoApps?.some((app) => app.enabled)).toBe(false);
    await click("Choose apps");
    await act(async () =>
      (document.querySelector('[aria-label="app0"]') as HTMLButtonElement).click(),
    );
    await click("Use selected apps");
    expect(current.monorepoApps?.map((app) => app.enabled)).toEqual([true, false]);
  });
  it("shows three of seven domains with a visible total and opens their owning app", async () => {
    await render(<MonorepoDomains />, { count: 7, selected: true });
    expect(host.textContent).toContain("Domains 7");
    expect(host.textContent).toContain("app2-repo.opsh.io");
    expect(host.textContent).not.toContain("app3-repo.opsh.io");
    await click("View all 7 domains");
    await act(async () =>
      (document.querySelector('[aria-label="App"]') as HTMLButtonElement).click(),
    );
    await act(async () =>
      (
        document.querySelector<HTMLElement>('[role="option"][data-value="apps/app6"]') ??
        ([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
          el.textContent?.includes("app6"),
        ) as HTMLElement)
      ).click(),
    );
    expect(document.querySelector('[aria-label="App"]')?.textContent).toContain("app6");
  });
  it("discards a stale folder scan and keeps a new app identity distinct", async () => {
    api.tree.mockResolvedValue({ data: [{ path: "app0/package.json", type: "file" }] });
    let resolve!: (value: unknown) => void;
    api.prepare.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const add = vi.fn();
    await render(<RepositoryAppPicker onClose={() => {}} onAdd={add} />);
    await click("app0");
    await click("Inspect folder");
    await click("Parent folder");
    await act(async () => resolve({ ...scan, projectType: "app", rootDirectory: "app0" }));
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Add app"),
    ).toBe(false);
    api.prepare.mockResolvedValueOnce({ ...scan, projectType: "app", rootDirectory: "app0" });
    await click("app0");
    await click("Inspect folder");
    await click("Add app");
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "app0-2", rootDirectory: "app0" }),
    );
    expect(current.monorepoApps?.[0].name).toBe("app0");
  });
  it("browses the repository and inspects only the selected folder before adding it", async () => {
    api.tree.mockResolvedValue({ data: [{ path: "custom/package.json", type: "file" }] });
    api.prepare.mockResolvedValue({ ...scan, projectType: "app", rootDirectory: "custom" });
    const add = vi.fn();
    await render(<RepositoryAppPicker onClose={() => {}} onAdd={add} />);
    expect(api.tree).toHaveBeenCalledWith("acme", "repo", "main", "server-pat-host");
    await click("custom");
    await click("Inspect folder");
    expect(api.prepare).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      branch: "main",
      serverId: "server-pat-host",
      rootDirectory: "custom",
    });
    expect(add).not.toHaveBeenCalled();
    await click("Add app");
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDirectory: "custom",
        enabled: true,
        buildCommand: "bun run build",
      }),
    );
  });
});
