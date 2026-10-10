// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GITHUB_DEPLOYMENT_CHECKS, type GitHubDeploymentChecks } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { GitHubChecksSettings } from "./GitHubChecksSettings";

const copy = baseDictionary.projectSettings.deploymentChecks;
let host: HTMLDivElement, root: Root, config: GitHubDeploymentChecks | undefined;
function Editor({ initial, disabled = false }: { initial?: GitHubDeploymentChecks; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  config = value;
  return <I18nProvider><GitHubChecksSettings value={value} onChange={setValue} services={["web", "db"]} disabled={disabled} /></I18nProvider>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function click(label: string) {
  const labels = [...host.querySelectorAll("label")];
  const field = labels.find(item => item.textContent === label);
  const button = field?.querySelector("button") ?? host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
describe("shared GitHub deployment Check settings", () => {
  it("defaults to enabled, with customization kept compact", async () => {
    await act(async () => root.render(<Editor />));
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("details")?.open).toBe(false);
    const checkboxes = host.querySelectorAll('[role="checkbox"]');
    expect([...checkboxes].every(node => node.getAttribute("aria-checked") === "true")).toBe(true);
  });
  it("supports selected service checks without losing choices when toggled off and on", async () => {
    await act(async () => root.render(<Editor />));
    await click(copy.services);
    await click("web");
    await click(copy.includeErrors);
    expect(config).toEqual({ ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, services: ["web"], includeErrors: false });
    await click(copy.title);
    expect(host.querySelector("details")).toBeNull();
    await click(copy.title);
    expect(config).toEqual({ ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, services: ["web"], includeErrors: false });
    await click(copy.services);
    expect(config?.services).toBe("all");
  });
  it("retains saved service choices even when the service list has not loaded", async () => {
    await act(async () => root.render(<Editor initial={{ ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, services: ["worker"] }} />));
    expect(host.textContent).toContain("worker");
    expect(config?.services).toEqual(["worker"]);
  });
  it("prevents concurrent edits while a source setting is being saved", async () => {
    await act(async () => root.render(<Editor disabled initial={{ ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS }} />));
    expect([...host.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
    await click(copy.title);
    expect(config?.enabled).toBe(true);
  });
});
