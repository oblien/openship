// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCapabilities } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { RunnerEditor } from "./RunnerEditor";

const h = vi.hoisted(() => ({ inspect: vi.fn(), save: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/api/actions", () => ({
  actionsApi: { inspectDestination: h.inspect, saveRunner: h.save },
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
    await submit();
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "mac",
        config: expect.objectContaining({ mode: "native", image: null, labels: [] }),
      }),
      undefined,
    );
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
});
