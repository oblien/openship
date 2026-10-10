// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCapabilities } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { RunnerEditor } from "./RunnerEditor";

const h = vi.hoisted(() => ({
  inspect: vi.fn(),
  emulation: vi.fn(),
  save: vi.fn(),
  push: vi.fn(),
  runners: vi.fn(),
}));
vi.mock("@/lib/api/actions", () => ({
  actionsApi: {
    inspectDestination: h.inspect,
    enableEmulation: h.emulation,
    saveRunner: h.save,
    runners: h.runners,
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: "org" } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "local" }));
vi.mock("@/components/shared/ServerSelector", () => ({
  default: ({ onSelect }: { onSelect: (server: { id: string; name: string }) => void }) => (
    <div>
      {["mac", "linux"].map((id) => (
        <button key={id} type="button" onClick={() => onSelect({ id, name: id })}>
          {id}
        </button>
      ))}
    </div>
  ),
}));

const capabilities = (os: "macos" | "linux"): ActionCapabilities => ({
  os,
  architecture: "arm64",
  docker: true,
  git: true,
  node: true,
  version: null,
  distribution: null,
});
let root: Root;
let host: HTMLDivElement;
const click = (name: string) =>
  act(async () => {
    [...host.querySelectorAll("button")].find((button) => button.textContent === name)!.click();
  });
const submit = () =>
  act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
const choosePreset = (value: string) =>
  act(async () => {
    document.querySelector<HTMLButtonElement>(`button[value="${value}"]`)!.click();
  });
async function fill(label: string, value: string) {
  const input = [...host.querySelectorAll<HTMLLabelElement>("label")]
    .find((item) => item.firstElementChild?.textContent === label)!
    .querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  h.inspect.mockImplementation(async (id: string) =>
    capabilities(id === "mac" ? "macos" : "linux"),
  );
  h.save.mockResolvedValue({ id: "runner" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider>
        <RunnerEditor />
      </I18nProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("capability-based runner setup", () => {
  it("selects native execution for a Mac even if Docker is installed", async () => {
    await click("mac");
    expect(host.textContent).not.toContain("Enable CPU emulation");
    await submit();
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "mac",
        config: expect.objectContaining({ mode: "native", image: null, labels: [] }),
      }),
      undefined,
    );
  });
  it("verifies emulation before advertising another architecture and locks the destination while setup runs", async () => {
    let finish!: (value: ActionCapabilities) => void;
    h.emulation.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await click("linux");
    await click("Enable CPU emulation");
    expect(h.emulation).toHaveBeenCalledWith("linux");
    expect(host.querySelector("fieldset")!.disabled).toBe(true);
    await submit();
    expect(h.save).not.toHaveBeenCalled();
    const verified: ActionCapabilities = {
      ...capabilities("linux"),
      dockerArchitecture: "arm64",
      dockerPlatforms: ["linux/arm64", "linux/amd64"],
    };
    h.inspect.mockResolvedValue(verified);
    await act(async () => finish(verified));
    expect(h.inspect).toHaveBeenLastCalledWith("linux");
    expect(host.textContent).toContain("x64 · Emulated");
    expect(host.textContent).not.toContain("Enable CPU emulation");
    await submit();
    expect(h.save.mock.calls[0]![0].config.allowDockerSocket).toBe(false);
  });
  it("keeps native containers available and exposes retry after emulation setup fails", async () => {
    h.emulation.mockRejectedValue(new Error("Docker cannot register the emulator"));
    await click("linux");
    await click("Enable CPU emulation");
    expect(host.textContent).toContain("Docker cannot register the emulator");
    expect(host.textContent).toContain("Enable CPU emulation");
    expect(host.textContent).not.toContain("x64 · Emulated");
    await submit();
    expect(h.save.mock.calls[0]![0]).toMatchObject({
      serverId: "linux",
      config: { mode: "container" },
    });
  });
  it("restores container defaults when moving from Mac to Linux", async () => {
    await click("mac");
    await click("linux");
    await submit();
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "linux",
        config: expect.objectContaining({
          mode: "container",
          labels: ["ubuntu-latest", "ubuntu-22.04"],
        }),
      }),
      undefined,
    );
  });
  it("ignores an old destination probe that resolves after a new server was chosen", async () => {
    let finish!: (value: ActionCapabilities) => void;
    h.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await click("mac");
    await click("linux");
    await act(async () => finish(capabilities("macos")));
    await submit();
    expect(h.save.mock.calls[0]![0]).toMatchObject({
      serverId: "linux",
      config: { mode: "container" },
    });
  });
  it("offers compatible catalog environments and applies native Linux without Ubuntu labels", async () => {
    await click("linux");
    await click("Browse catalog");
    expect(document.querySelector<HTMLButtonElement>('button[value="macos"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[value="ubuntu"]')!.disabled).toBe(
      false,
    );
    await choosePreset("linux");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await submit();
    expect(h.save.mock.calls[0]![0].config).toMatchObject({
      mode: "native",
      image: null,
      labels: [],
    });
  });
  it("opens custom-image controls and never gives a custom image Ubuntu labels", async () => {
    await click("linux");
    await click("Browse catalog");
    await choosePreset("custom");
    expect(host.querySelector("details")!.open).toBe(true);
    await submit();
    expect(h.save).not.toHaveBeenCalled();
    await fill("Runner image", "registry.example/ci/node:22");
    await fill("vCPU per container", "2");
    await fill("Memory per container (MiB)", "4096");
    await fill("Additional labels", "ci, build");
    await submit();
    expect(h.save.mock.calls[0]![0].config).toMatchObject({
      mode: "container",
      image: "registry.example/ci/node:22",
      cpu: 2,
      memoryMb: 4096,
      labels: ["ci", "build"],
    });
  });
  it("keeps resource limits when switching environment presets", async () => {
    await click("linux");
    await fill("vCPU per container", "3");
    await fill("Memory per container (MiB)", "4096");
    await click("Browse catalog");
    await choosePreset("linux");
    await click("Browse catalog");
    await choosePreset("ubuntu");
    await submit();
    expect(h.save.mock.calls[0]![0].config).toMatchObject({
      mode: "container",
      image: "catthehacker/ubuntu:act-22.04",
      cpu: 3,
      memoryMb: 4096,
      labels: ["ubuntu-latest", "ubuntu-22.04"],
    });
  });
  it("preserves the chosen environment when reselecting the same server", async () => {
    await click("linux");
    await click("Browse catalog");
    await choosePreset("linux");
    await click("linux");
    await fill("Runner name", "Native build runner");
    await submit();
    expect(h.save.mock.calls[0]![0]).toMatchObject({
      name: "Native build runner",
      config: { mode: "native", image: null, labels: [] },
    });
  });
  it("can recheck missing native tools and never enables Docker presets without Docker", async () => {
    h.inspect.mockResolvedValue({ ...capabilities("linux"), docker: false, node: false });
    await click("linux");
    expect(host.textContent).toContain("Install Node.js");
    await submit();
    expect(h.save).not.toHaveBeenCalled();
    await click("Browse catalog");
    expect(document.querySelector<HTMLButtonElement>('button[value="ubuntu"]')!.disabled).toBe(
      true,
    );
    expect(document.querySelector<HTMLButtonElement>('button[value="custom"]')!.disabled).toBe(
      true,
    );
    await choosePreset("linux");
    h.inspect.mockResolvedValue({ ...capabilities("linux"), docker: false });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Check capabilities"]')!.click(),
    );
    await submit();
    expect(h.save.mock.calls[0]![0].config).toMatchObject({ mode: "native", image: null });
  });
  it("preserves an existing runner's custom image, labels and limits during inspection", async () => {
    const config = {
      mode: "container",
      image: "registry.example/ci:stable",
      labels: ["private-ci"],
      cpu: 4,
      memoryMb: 8192,
      maxParallel: 2,
      allowDockerSocket: false,
    };
    h.runners.mockResolvedValue([
      {
        id: "saved",
        serverId: "linux",
        name: "Existing runner",
        kind: "server",
        config,
        enabled: false,
      },
    ]);
    await act(async () =>
      root.render(
        <I18nProvider>
          <RunnerEditor id="saved" />
        </I18nProvider>,
      ),
    );
    await submit();
    expect(h.save).toHaveBeenCalledWith(
      { serverId: "linux", name: "Existing runner", config, enabled: false },
      "saved",
    );
  });
});
