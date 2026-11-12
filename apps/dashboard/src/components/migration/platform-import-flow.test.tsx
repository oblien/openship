// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCredentialProvider } from "@repo/core";
import type { PlatformDiscovery, PlatformMigrationPlan } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import type { Credential } from "@/lib/api/credentials";
import { PlatformMigrationWizard } from "./PlatformMigrationWizard";

const h = vi.hoisted(() => ({
  providers: vi.fn(),
  list: vi.fn(),
  verify: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  authorize: vi.fn(),
  projects: vi.fn(),
  discover: vi.fn(),
  review: vi.fn(),
  start: vi.fn(),
  getMigration: vi.fn(),
  confirmCutover: vi.fn(),
  cancel: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api/credentials", () => ({ credentialsApi: h }));
vi.mock("@/lib/api/platform-migration", () => ({ platformMigrationApi: h }));
vi.mock("@/lib/api/server-migration", () => ({ dockerMigrationApi: h }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/components/shared/ServerSelector", () => ({
  default: ({
    onSelect,
    onReadyChange,
    disabled,
  }: {
    onSelect: (server: { id: string; name: string }) => void;
    onReadyChange: (ready: boolean) => void;
    disabled: boolean;
  }) => {
    useEffect(() => onReadyChange(true), [onReadyChange]);
    return (
      <button
        disabled={disabled}
        onClick={() => onSelect({ id: "server-b", name: "Second server" })}
      >
        Use second server
      </button>
    );
  },
}));

const credential: Credential = {
  id: "connection",
  provider: "railway",
  providerLabel: "Railway",
  name: "Production workspace",
  selector: null,
  publicFields: { tokenType: "account" },
  secretsMasked: { apiToken: "********" },
  status: "active",
  lastVerifiedAt: null,
  lastError: null,
  createdAt: "",
  updatedAt: "",
};
const discovery: PlatformDiscovery = {
  draftId: "draft",
  provider: "railway",
  projectName: "Production",
  environmentName: "Production",
  warnings: [],
  services: [
    {
      id: "db",
      name: "PostgreSQL",
      kind: "database",
      image: "postgres:17",
      variables: [],
      volumes: [{ id: "data", mountPath: "/var/lib/postgresql/data" }],
      domains: [],
      warnings: [],
      blockers: [],
    },
    {
      id: "web",
      name: "Website",
      kind: "app",
      repository: "https://github.com/example/web",
      commit: "a".repeat(40),
      variables: [{ key: "API_TOKEN", required: true }],
      volumes: [],
      domains: [],
      warnings: [],
      blockers: [],
    },
  ],
};
const plan: PlatformMigrationPlan = {
  ...discovery,
  planId: "plan",
  targetServerId: "server-a",
  ready: true,
  requiresWritePause: true,
  requiresWorkerPause: false,
};
let host: HTMLDivElement;
let root: Root;
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(input: HTMLInputElement, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(provider: "railway" | "vercel" = "railway", initialRunId?: string) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <PlatformMigrationWizard
          provider={provider}
          initialRunId={initialRunId}
          initialTargetId="server-a"
          onBack={() => {}}
        />
      </I18nProvider>,
    ),
  );
}
async function selectServices() {
  await click("Choose services");
  await fill(host.querySelector<HTMLInputElement>('input[type="password"]')!, "fixture-secret");
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.providers.mockResolvedValue({
    data: [getCredentialProvider("railway"), getCredentialProvider("vercel")],
  });
  h.list.mockResolvedValue({ data: [credential] });
  h.verify.mockResolvedValue({ data: credential });
  h.projects.mockResolvedValue({
    projects: [
      { id: "project", name: "Production", environments: [{ id: "prod", name: "Production" }] },
    ],
  });
  h.discover.mockResolvedValue(discovery);
  h.review.mockResolvedValue(plan);
  h.start.mockResolvedValue({
    success: true,
    migrationId: "run",
    confirmationToken: "confirmation",
  });
  h.getMigration.mockResolvedValue({
    run: {
      id: "run",
      status: "awaiting_cutover",
      projectName: "Production",
      logs: "",
      importedProjects: {},
      confirmationToken: "confirmation",
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("platform import flow", () => {
  it("keeps an accepted stop visible through stale polls until the worker finishes", async () => {
    vi.useFakeTimers();
    let current = {
      id: "run",
      status: "moving_data",
      cancelRequested: false,
      projectName: "Production",
      logs: "",
    };
    h.getMigration.mockImplementation(async () => ({ run: current }));
    h.cancel.mockResolvedValue({ success: true });
    await render("railway", "run");
    await click("Stop import");
    expect(h.cancel).toHaveBeenCalledWith("run");
    expect(button("Stopping…").disabled).toBe(true);
    expect(host.textContent).toContain("Stop requested");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(button("Stopping…").disabled).toBe(true);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    current = { ...current, status: "rolled_back", cancelRequested: true };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(host.textContent).toContain("Copied data and saved projects were retained");
    expect(host.textContent).not.toContain("Stop requested");
    expect(
      [...host.querySelectorAll("button")].some(
        (item) => item.textContent?.trim() === "Stop import",
      ),
    ).toBe(false);
  });

  it("restores a pending stop from the server when the import is reopened", async () => {
    h.getMigration.mockResolvedValue({
      run: {
        id: "run",
        status: "deploying",
        cancelRequested: true,
        projectName: "Production",
        logs: "",
      },
    });
    await render("railway", "run");
    expect(host.textContent).toContain("Stop requested");
    expect(button("Stopping…").disabled).toBe(true);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("allows retry when a stop request is rejected", async () => {
    h.getMigration.mockResolvedValue({
      run: { id: "run", status: "moving_data", projectName: "Production", logs: "" },
    });
    h.cancel
      .mockRejectedValueOnce(new Error("Stop request unavailable"))
      .mockResolvedValueOnce({ success: true });
    await render("railway", "run");
    await click("Stop import");
    expect(host.textContent).toContain("Stop request unavailable");
    expect(button("Stop import").disabled).toBe(false);
    await click("Stop import");
    expect(h.cancel).toHaveBeenCalledTimes(2);
    expect(button("Stopping…").disabled).toBe(true);
  });

  it("accepts OAuth completion only from its own popup and unlocks the next step", async () => {
    h.list.mockResolvedValueOnce({ data: [] });
    h.providers.mockResolvedValue({
      data: [{ ...getCredentialProvider("vercel"), authorization: { available: true } }],
    });
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { replace: vi.fn() },
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    h.authorize.mockResolvedValue({
      state: "oauth-state",
      url: "https://vercel.com/oauth/authorize",
    });
    await render("vercel");
    // One tab chooses authorization and the submit button starts it.
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(popup.location.replace).toHaveBeenCalledWith("https://vercel.com/oauth/authorize");
    const finish = (origin: string, source: Window) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source,
          data: { type: "openship:connection", state: "oauth-state" },
        }),
      );
    await act(async () => {
      finish("https://unrelated.example", popup);
      finish(window.location.origin, window);
    });
    expect(h.list).toHaveBeenCalledTimes(1);
    h.list.mockResolvedValue({
      data: [
        {
          ...credential,
          provider: "vercel",
          name: "Vercel connection",
          publicFields: { authorization: "oauth" },
        },
      ],
    });
    await act(async () => finish(window.location.origin, popup));
    expect(popup.close).toHaveBeenCalled();
    expect(host.textContent).toContain("Project access verified");
    expect(button("Choose services").disabled).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("opens the shared connection form when none exist and verifies project access after saving", async () => {
    h.list.mockResolvedValue({ data: [] });
    h.create.mockResolvedValue({ data: { ...credential, provider: "vercel" } });
    await render("vercel");
    expect(host.textContent).toContain("Connect Vercel");
    const token = host.querySelector<HTMLInputElement>('input[id$="-apiToken"]')!;
    expect(token.type).toBe("text");
    expect(token.autocomplete).toBe("off");
    expect(button("Test & connect").form).toBe(token.form);
    await click("Test & connect");
    expect(h.create).not.toHaveBeenCalled(); // External submit still validates required fields.
    await fill(token, "test-token");
    await click("Test & connect");
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "vercel", values: { apiToken: "test-token" } }),
    );
    expect(h.projects).toHaveBeenCalledWith("connection");
    expect(host.textContent).toContain("Project access verified");
    expect(button("Choose services").disabled).toBe(false);
  });

  it("distinguishes failed access from an empty account and allows an explicit retest", async () => {
    h.projects.mockRejectedValueOnce(new Error("Workspace access denied"));
    await render();
    expect(host.textContent).toContain("Workspace access denied");
    expect(button("Choose services").disabled).toBe(true);
    h.verify.mockResolvedValueOnce({
      data: { ...credential, status: "invalid", lastError: "Token expired" },
    });
    await click("Test connection");
    expect(host.textContent).toContain("Token expired");
    expect(h.projects).toHaveBeenCalledTimes(1);
    h.projects.mockResolvedValueOnce({ projects: [] });
    await click("Test connection");
    expect(host.textContent).toContain("No projects were returned");
    expect(host.textContent).not.toContain("Token expired");
    expect(button("Choose services").disabled).toBe(true);
    await click("Test connection");
    expect(button("Choose services").disabled).toBe(false);
  });

  it("requires missing secrets, a separate review, and writer pause before starting exactly once", async () => {
    await render();
    await click("Choose services");
    expect(button("Check import").disabled).toBe(true);
    await fill(host.querySelector<HTMLInputElement>('input[type="password"]')!, "fixture-secret");
    await click("Check import");
    expect(h.review).toHaveBeenCalledWith(
      expect.objectContaining({
        targetServerId: "server-a",
        services: expect.arrayContaining([
          expect.objectContaining({ id: "web", env: { API_TOKEN: "fixture-secret" } }),
        ]),
      }),
    );
    expect(h.start).not.toHaveBeenCalled();
    expect(button("Import 2 projects").disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    let resolve!: (value: unknown) => void;
    h.start.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const start = button("Import 2 projects");
    await act(async () => {
      start.click();
      start.click();
    });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith({
      planId: "plan",
      writesPaused: true,
      workersPaused: false,
    });
    await act(async () => resolve({ migrationId: "run", confirmationToken: "confirmation" }));
    expect(h.push).toHaveBeenCalledWith("/migrations/run");
  });

  it("keeps blocked reviews in the editor and requires a fresh review after changing destination", async () => {
    h.review.mockResolvedValueOnce({
      ...plan,
      ready: false,
      services: [
        { ...discovery.services[0], blockers: ["Reconnect GitHub to access the repository."] },
        discovery.services[1],
      ],
    });
    await render();
    await selectServices();
    await click("Check import");
    expect(host.textContent).toContain("Reconnect GitHub");
    expect(button("Check import").disabled).toBe(false);
    expect(h.start).not.toHaveBeenCalled();
    await click("Check import");
    await click("Edit selection");
    await click("Use second server");
    expect(button("3Review & import").disabled).toBe(true);
    await click("Check import");
    expect(h.review).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetServerId: "server-b" }),
    );
    expect(button("Import 2 projects").disabled).toBe(true);
  });

  it("returns to editable services when a review request fails", async () => {
    h.review.mockRejectedValueOnce(new Error("Provider rate limited. Try again."));
    await render();
    await selectServices();
    await click("Check import");
    expect(host.textContent).toContain("Provider rate limited");
    expect(button("Check import").disabled).toBe(false);
    await click("Check import");
    expect(host.textContent).toContain("Review complete");
    expect(host.textContent).not.toContain("Provider rate limited");
  });
});
