// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import BuildSettings from "./BuildSettings";

const h = vi.hoisted(() => ({
  config: {} as Record<string, any>,
  updateConfig: vi.fn(),
  updateOptions: vi.fn(),
}));
vi.mock("@/context/DeploymentContext", () => ({ useOptionalDeployment: () => h }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: "opsh.io" }) }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (copy: string) => copy,
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.config = {
    framework: "laravel",
    buildImage: "php:8.4-cli",
    options: { hasBuild: true, hasServer: true },
    publicEndpoints: [],
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function choose(version: string) {
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click(),
  );
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (row) => row.textContent === `PHP ${version}`,
  );
  expect(option).toBeDefined();
  await act(async () => option!.click());
}
it("offers a matched builder selection in the existing PHP configuration", async () => {
  await act(async () => root.render(<BuildSettings />));
  expect(host.textContent).toContain("Default (8.4)");
  await choose("8.3");
  expect(h.updateConfig).toHaveBeenCalledWith({
    runtimeVersion: "8.3",
    buildImage: "php:8.3-cli-bookworm",
  });
});
it("shows why a custom builder cannot be used with another version", async () => {
  h.config.runtimeVersion = "8.3";
  h.config.buildImage = "php:8.3.30-cli-bookworm";
  await act(async () => root.render(<BuildSettings />));
  await choose("8.4");
  expect(h.updateConfig).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("uses PHP 8.3");
});
it("does not show PHP controls for other stacks", async () => {
  h.config.framework = "node";
  await act(async () => root.render(<BuildSettings />));
  expect(host.textContent).not.toContain(
    baseDictionary.importProject.buildSettings.runtimeVersionLabel,
  );
});

it("keeps Composer enabled when a new version is selected without an asset build", async () => {
  h.config.options = {
    hasBuild: false,
    hasServer: true,
    installCommand: "composer install",
    buildCommand: "",
  };
  await act(async () => root.render(<BuildSettings />));
  await choose("8.3");
  expect(h.updateConfig).toHaveBeenCalledWith({
    runtimeVersion: "8.3",
    buildImage: "php:8.3-cli-bookworm",
    options: { ...h.config.options, hasBuild: true },
  });
});

it("shows runtime settings directly, and clears an explicit Docker runtime image", async () => {
  h.config.runtimeMode = "docker";
  h.config.runtimeImage = "custom/runtime:83";
  await act(async () => root.render(<BuildSettings />));
  const runtime = host.querySelector<HTMLElement>('section[aria-labelledby]');
  expect(runtime?.textContent).toContain(baseDictionary.importProject.buildSettings.runtimeTitle);
  expect(runtime?.textContent).toContain(baseDictionary.importProject.buildSettings.runtimeVersionLabel);
  expect(runtime?.textContent).toContain(baseDictionary.importProject.buildSettings.buildImageLabel);
  expect(input(baseDictionary.importProject.buildSettings.buildImageLabel).closest("section")).toBe(runtime);
  const advanced = Array.from(host.querySelectorAll("button")).find(button =>
    button.textContent === baseDictionary.importProject.buildSettings.advanced,
  );
  expect(advanced?.getAttribute("aria-expanded")).toBe("false");
  expect(
    Array.from(host.querySelectorAll<HTMLInputElement>("input")).filter(
      (input) => input.value === "custom/runtime:83",
    ),
  ).toHaveLength(1);
  const runtimeInput = Array.from(host.querySelectorAll<HTMLInputElement>("input")).find(
    (input) => input.value === "custom/runtime:83",
  );
  expect(runtimeInput).toBeDefined();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(runtimeInput, "");
    runtimeInput!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(h.updateConfig).toHaveBeenCalledWith({ runtimeImage: null });
});

it("hides the runtime image field for a bare app without an override", async () => {
  h.config.runtimeMode = "bare";
  await act(async () => root.render(<BuildSettings />));
  const advanced = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(baseDictionary.importProject.buildSettings.advanced),
  );
  expect(advanced).toBeDefined();
  await act(async () => advanced!.click());
  expect(host.textContent).not.toContain(
    baseDictionary.importProject.buildSettings.runtimeImageLabel,
  );
  expect(host.textContent).not.toContain(baseDictionary.importProject.buildSettings.runtimeVersionLabel);
  expect(host.textContent).toContain(baseDictionary.importProject.buildSettings.runtimeBareDesc);
});

function input(label: string): HTMLInputElement {
  const target = Array.from(host.querySelectorAll("label")).find(row => row.textContent?.startsWith(label));
  expect(target).toBeDefined();
  return document.getElementById(target!.htmlFor) as HTMLInputElement;
}

async function setInput(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it.each([
  [{ runtimeMode: "bare" }, "runtimeBareDesc"],
  [{ options: { hasBuild: true, hasServer: false, workloadType: "static" } }, "runtimeStaticDesc"],
  [{ projectType: "docker" }, "runtimeDockerfileDesc"],
  [{ buildKind: "dockerfile" }, "runtimeDockerfileDesc"],
  [{ projectType: "services" }, "runtimeServicesDesc"],
  [{ composePath: "compose.yml" }, "runtimeServicesDesc"],
  [{ sourceKind: "image" }, "runtimePrebuiltDesc"],
] as const)("explains runtime ownership without offering ignored controls: %j", async (changes, key) => {
  Object.assign(h.config, changes);
  await act(async () => root.render(<BuildSettings />));
  expect(host.textContent).toContain(baseDictionary.importProject.buildSettings[key]);
  expect(host.querySelector('button[aria-haspopup="listbox"]')).toBeNull();
  expect(Array.from(host.querySelectorAll("label")).some(row => row.textContent?.startsWith(
    baseDictionary.importProject.buildSettings.runtimeImageLabel,
  ))).toBe(false);
  expect(h.updateConfig).not.toHaveBeenCalled();
  if (key !== "runtimeStaticDesc")
    expect(Array.from(host.querySelectorAll("label")).some(row => row.textContent?.startsWith(
      baseDictionary.importProject.buildSettings.buildImageLabel,
    ))).toBe(false);
});

it("exposes a static Docker builder without offering a running runtime image", async () => {
  Object.assign(h.config, {
    framework: "vite",
    runtimeMode: "docker",
    buildKind: "static",
    buildImage: "node:22",
    options: { hasBuild: true, hasServer: false, workloadType: "static" },
  });
  await act(async () => root.render(<BuildSettings />));
  const builder = input(baseDictionary.importProject.buildSettings.buildImageLabel);
  expect(builder.value).toBe("node:22");
  expect(builder.closest("section")?.textContent).toContain(baseDictionary.importProject.buildSettings.runtimeStaticDesc);
  expect(Array.from(host.querySelectorAll("label")).some(row => row.textContent?.startsWith(
    baseDictionary.importProject.buildSettings.runtimeImageLabel,
  ))).toBe(false);
  await setInput(builder, "oven/bun:1.3.14");
  expect(h.updateConfig).toHaveBeenCalledWith({ buildImage: "oven/bun:1.3.14" });
});

it("keeps the builder in Runtime when Advanced opens, without a duplicate editor", async () => {
  await act(async () => root.render(<BuildSettings />));
  const advanced = Array.from(host.querySelectorAll("button")).find(button =>
    button.textContent === baseDictionary.importProject.buildSettings.advanced,
  )!;
  await act(async () => advanced.click());
  const builders = Array.from(host.querySelectorAll("label")).filter(row => row.textContent?.startsWith(
    baseDictionary.importProject.buildSettings.buildImageLabel,
  ));
  expect(builders).toHaveLength(1);
  expect(builders[0].closest("section")).not.toBeNull();
});

it("shows an incompatible builder image beside the visible runtime settings", async () => {
  Object.assign(h.config, { runtimeVersion: "8.3", buildImage: "php:8.4-cli-bookworm" });
  await act(async () => root.render(<BuildSettings />));
  const builder = input(baseDictionary.importProject.buildSettings.buildImageLabel);
  expect(builder.value).toBe("php:8.4-cli-bookworm");
  await act(async () => builder.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  const error = host.querySelector('[role="alert"]');
  expect(error?.textContent).toContain("uses PHP 8.4");
  expect(error?.closest("section")).toBe(builder.closest("section"));
  expect(h.updateConfig).not.toHaveBeenCalled();
});

it("keeps image digest pins explicit when choosing another supported version", async () => {
  const image = `private.example/php-runtime:8.3@sha256:${"a".repeat(64)}`;
  h.config.runtimeImage = image;
  await act(async () => root.render(<BuildSettings />));
  expect(input(baseDictionary.importProject.buildSettings.runtimeImageLabel).value).toBe(image);
  await choose("8.3");
  expect(h.updateConfig).toHaveBeenCalledWith({ runtimeVersion: "8.3", buildImage: "php:8.3-cli-bookworm" });
  expect(h.updateConfig.mock.calls[0][0]).not.toHaveProperty("runtimeImage");
});

it("shows a generic runtime image for an undetected stack and preserves custom values", async () => {
  const image = "private.example/custom:stable";
  Object.assign(h.config, { framework: "unknown", runtimeImage: image });
  await act(async () => root.render(<BuildSettings />));
  expect(host.textContent).toContain(baseDictionary.importProject.buildSettings.runtimeTitle);
  expect(host.textContent).not.toContain(baseDictionary.importProject.buildSettings.runtimeVersionLabel);
  expect(input(baseDictionary.importProject.buildSettings.runtimeImageLabel).value).toBe(image);
  expect(h.updateConfig).not.toHaveBeenCalled();
  await setInput(input(baseDictionary.importProject.buildSettings.runtimeImageLabel), "other.example/runtime:1");
  expect(h.updateConfig).toHaveBeenCalledWith({ runtimeImage: "other.example/runtime:1" });
});

it("lets an unknown version be cleared without losing a custom runtime image", async () => {
  const image = "private.example/custom:stable";
  Object.assign(h.config, { framework: "unknown", runtimeVersion: "22", runtimeImage: image });
  await act(async () => root.render(<BuildSettings />));
  const select = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  expect(select.textContent).toContain("22");
  await act(async () => select.click());
  const reset = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    row => row.textContent === baseDictionary.importProject.buildSettings.runtimeVersionDefault,
  )!;
  await act(async () => reset.click());
  expect(h.updateConfig).toHaveBeenCalledWith({ runtimeVersion: null });
});

it("allows saved overrides to be removed on an unsupported target", async () => {
  Object.assign(h.config, { runtimeMode: "bare", runtimeVersion: "8.3", runtimeImage: "private.example/custom:83" });
  await act(async () => root.render(<BuildSettings />));
  expect(host.textContent).toContain("private.example/custom:83");
  expect(host.textContent).toContain(baseDictionary.importProject.buildSettings.runtimeOverrideUnused);
  const clear = Array.from(host.querySelectorAll("button")).find(
    button => button.textContent === baseDictionary.importProject.buildSettings.clearRuntimeOverrides,
  )!;
  await act(async () => clear.click());
  expect(h.updateConfig).toHaveBeenCalledWith({ runtimeVersion: null, runtimeImage: null });
});
