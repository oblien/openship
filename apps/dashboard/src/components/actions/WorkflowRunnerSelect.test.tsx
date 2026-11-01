// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCapabilities } from "@repo/core";
import type { ActionRunnerView } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { WorkflowRunnerSelect } from "./WorkflowRunnerSelect";

vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
vi.mock("./RunnerEditor", () => ({ RunnerSetupDialog: () => null }));
vi.mock("./ActionBudget", () => ({ ActionBudgetDialog: () => null }));

const capabilities: ActionCapabilities = {
  os: "linux",
  architecture: "x64",
  docker: true,
  dockerArchitecture: "x64",
  git: true,
  node: true,
  distribution: "ubuntu",
  version: "24.04",
};
const runner: ActionRunnerView = {
  id: "runner",
  name: "Build server",
  serverId: "server",
  kind: "server",
  enabled: true,
  checkedAt: "2026-10-11T10:00:00Z",
  error: null,
  capabilities,
  config: {
    mode: "container",
    image: "catthehacker/ubuntu:act-22.04",
    labels: ["ubuntu-22.04"],
    cpu: 1,
    memoryMb: 2048,
    maxParallel: 2,
    allowDockerSocket: false,
  },
  labels: ["self-hosted", "openship", "linux", "x64", "ubuntu-22.04"],
};
const onChange = vi.fn();
const refresh = vi.fn();
let root: Root;
let host: HTMLDivElement;
function Harness({ runners, initial = [] }: { runners: ActionRunnerView[]; initial?: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <WorkflowRunnerSelect
      runners={runners}
      value={value}
      onChange={(ids) => {
        onChange(ids);
        setValue(ids);
      }}
      onCreated={() => {}}
      refresh={refresh}
    />
  );
}
const render = (runners = [runner], initial: string[] = []) =>
  act(async () => {
    root.render(
      <I18nProvider>
        <Harness runners={runners} initial={initial} />
      </I18nProvider>,
    );
  });
const click = (label: string) =>
  act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.getAttribute("aria-label") === label || item.textContent === label,
    );
    expect(button, label).toBeTruthy();
    button!.click();
  });
const choice = () =>
  document.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Build server"]')!;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("runner capability selection", () => {
  it("separates the host, image and routing labels without treating labels as capabilities", async () => {
    await render([{ ...runner, labels: [...runner.labels, "arm64", "macos-latest"] }]);
    await click("Allowed runners");
    expect(choice().textContent).toContain("x64 · Native");
    expect(choice().textContent).not.toMatch(/ARM64|macos-latest|ubuntu-22.04/);
    const details = document.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("ubuntu 24.04 · x64");
    expect(details.textContent).toContain("catthehacker/ubuntu:act-22.04");
    expect(details.textContent).toContain("1 vCPU · 2 GiB");
    expect(details.textContent).toContain("macos-latest");
    expect(onChange).not.toHaveBeenCalled();
    await click("Build server");
    expect(onChange).toHaveBeenLastCalledWith([runner.id]);
    await click("Use selected runners");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toMatch(/ubuntu-22.04|macos-latest/);
  });

  it.each([
    {
      name: "verified ARM64 emulation on Linux",
      cap: {
        ...capabilities,
        dockerPlatforms: ["linux/amd64", "linux/arm64"],
      } as ActionCapabilities,
      mode: "container" as const,
      native: "x64",
      emulated: "ARM64",
      os: "Linux",
    },
    {
      name: "Docker daemon architecture instead of a Mac client's CPU",
      cap: {
        ...capabilities,
        os: "macos",
        architecture: "arm64",
        dockerPlatforms: ["linux/amd64", "linux/arm64"],
      } as ActionCapabilities,
      mode: "container" as const,
      native: "x64",
      emulated: "ARM64",
      os: "Linux",
    },
    {
      name: "native Mac execution even when Docker has emulation",
      cap: {
        ...capabilities,
        os: "macos",
        architecture: "arm64",
        dockerPlatforms: ["linux/amd64", "linux/arm64"],
      } as ActionCapabilities,
      mode: "native" as const,
      native: "ARM64",
      emulated: null,
      os: "macOS",
    },
  ])("shows $name", async ({ cap, mode, native, emulated, os }) => {
    await render([{ ...runner, capabilities: cap, config: { ...runner.config, mode } }]);
    await click("Allowed runners");
    expect(choice().textContent).toContain(os);
    expect(choice().textContent).toContain(`${native} · Native`);
    if (emulated) expect(choice().textContent).toContain(`${emulated} · Emulated`);
    else expect(choice().textContent).not.toMatch(/Docker|Emulated|x64/);
  });

  it("updates verified capabilities after refresh without changing selection", async () => {
    await render([runner], [runner.id]);
    await click("Allowed runners");
    await click("Refresh");
    expect(refresh).toHaveBeenCalledOnce();
    await render([
      {
        ...runner,
        capabilities: { ...capabilities, dockerPlatforms: ["linux/amd64", "linux/arm64"] },
      },
    ]);
    expect(choice().getAttribute("aria-checked")).toBe("true");
    expect(choice().textContent).toContain("ARM64 · Emulated");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets an already selected disabled runner be removed without enabling it again", async () => {
    await render([{ ...runner, enabled: false }], [runner.id]);
    await click("Allowed runners");
    expect(choice().disabled).toBe(false);
    await click("Build server");
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(choice().disabled).toBe(true);
    await click("Build server");
    expect(onChange).toHaveBeenCalledOnce();
    expect(
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent === "Use selected runners",
      )!.disabled,
    ).toBe(true);
  });

  it("keeps unchecked and failed probes visible instead of advertising a verified platform", async () => {
    await render([{ ...runner, capabilities: null, error: "SSH unavailable" }]);
    await click("Allowed runners");
    expect(choice().textContent).toContain("Capabilities not checked");
    expect(choice().textContent).toContain("Check failed");
    expect(choice().textContent).not.toMatch(/Docker|Native|Emulated/);
  });

  it("shows a missing Docker engine after a new probe even if old routing labels remain", async () => {
    await render([{ ...runner, capabilities: { ...capabilities, docker: false } }]);
    await click("Allowed runners");
    expect(choice().textContent).toContain("Requires Docker on the server");
    expect(choice().textContent).not.toMatch(/x64|ARM64|Native|Emulated/);
  });
});
