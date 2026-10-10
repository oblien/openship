// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentContext } from "@/context/DeploymentContext";
import DeploymentDetails from "@/components/import-project/DeploymentDetails";
import { baseDictionary } from "@/i18n";
import { ApiError } from "@/lib/api/client";
import { useDeploymentBuild } from "./useDeploymentBuild";
import {
  DEFAULT_CONFIG,
  INITIAL_STATE,
  resolveBuildElapsedMs,
  type DeploymentContextType,
  type DeploymentConfig,
} from "./types";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  redeploy: vi.fn(),
  cancel: vi.fn(),
  respond: vi.fn(),
  toast: vi.fn(),
  ensure: vi.fn(), buildAccess: vi.fn(), getEnv: vi.fn(), pricing: vi.fn(),
  policy: vi.fn(), setOptions: vi.fn(),
  callbacks: {} as Record<string, (...args: any[]) => void>,
  stream: { isConnected: true, connect: vi.fn(), disconnect: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
  deployApi: {
    getBuildStatus: api.status,
    buildRedeploy: api.redeploy,
    cancel: api.cancel,
    buildAccess: api.buildAccess,
    buildRespond: api.respond,
  },
  projectsApi: { ensure: api.ensure, getEnv: api.getEnv, setOptions: api.setOptions },
}));
vi.mock("@/lib/api/actions", () => ({ actionsApi: { updateProjectPolicy: api.policy } }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: api.toast }) }));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => api.pricing }));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: vi.fn() }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({}) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, baseDomain: "example.test" }),
  canUseCloudConnection: () => false,
}));
vi.mock("@/context/ModalContext", () => ({ useModal: () => ({}) }));
vi.mock("@/context/GitHubContext", () => ({ useGitHub: () => ({ state: {} }) }));
vi.mock("@/components/github/ServerGitHubConnect", () => ({
  useServerGitHubConnectModal: () => vi.fn(),
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string) => text,
}));
vi.mock("@/hooks/useSSEConnection", () => ({
  useBuildStream: ({ callbacks }: { callbacks: typeof api.callbacks }) => {
    api.callbacks = callbacks;
    return api.stream;
  },
}));

const START = new Date("2026-09-24T10:00:00.000Z");
const snapshot = (extra: Record<string, unknown> = {}) => ({
  success: true,
  deployment_id: "dep-old",
  project_id: "project-1",
  status: "building",
  is_active: true,
  cancellationPending: false,
  buildStartedAt: START.toISOString(),
  buildDurationMs: null,
  ...extra,
});

let build: ReturnType<typeof useDeploymentBuild>;
let root: Root;
let container: HTMLDivElement;

function Harness({ initial = {} }: { initial?: Partial<DeploymentConfig> }) {
  const [config, setConfig] = useState({ ...DEFAULT_CONFIG, ...initial });
  build = useDeploymentBuild(config, setConfig);
  return (
    <DeploymentContext.Provider value={{ config, ...build } as DeploymentContextType}>
      <DeploymentDetails />
    </DeploymentContext.Provider>
  );
}

async function mount(initial?: Partial<DeploymentConfig>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness initial={initial} />));
}

async function load(extra: Record<string, unknown> = {}) {
  api.status.mockResolvedValue(snapshot(extra));
  await act(async () => {
    await build.loadBuildSession("dep-old");
  });
}

function clockText() {
  const label = [...container.querySelectorAll("dt")].find(
    (span) => span.textContent === baseDictionary.importProject.deploymentProcessing.detailBuildTime,
  );
  return label?.nextElementSibling?.textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START.getTime() + 10_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.stream.isConnected = true;
  api.status.mockResolvedValue(snapshot());
  api.pricing.mockReturnValue(false);
  api.policy.mockReset().mockResolvedValue({});
  api.setOptions.mockResolvedValue({ success: true });
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("held backup decisions", () => {
  const prompt = (attempt: number) => ({
    promptId: `backup:${attempt}`,
    title: "Backup failed",
    message: "The new release has not started.",
    actions: [{ id: `retry:${attempt}`, label: "Retry backup" }],
  });

  it.each(["network error", "rejected choice"])(
    "restores the prompt on refresh and retains it after a %s",
    async (failure) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await mount();
      await load({ pendingPrompt: prompt(1) });
      expect(build.state.pendingPrompt?.promptId).toBe("backup:1");
      if (failure === "network error")
        api.respond.mockRejectedValueOnce(new Error("Connection interrupted"));
      else api.respond.mockResolvedValueOnce({ success: false });
      await act(async () => {
        await expect(build.respondToPrompt("retry:1")).rejects.toThrow();
      });
      expect(build.state.pendingPrompt?.promptId).toBe("backup:1");
      api.respond.mockResolvedValueOnce({ success: true });
      await act(async () => {
        await build.respondToPrompt("retry:1");
      });
      expect(build.state.pendingPrompt).toBeNull();
    },
  );

  it("does not clear the next backup failure when the previous response finishes late", async () => {
    await mount();
    await load({ pendingPrompt: prompt(1) });
    let finish!: (value: { success: boolean }) => void;
    api.respond.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const response = build.respondToPrompt("retry:1");
    await act(async () => {
      api.callbacks.onPrompt!(prompt(2));
    });
    await act(async () => {
      finish({ success: true });
      await response;
    });
    expect(build.state.pendingPrompt?.promptId).toBe("backup:2");
  });

  it("clears a held backup prompt when its unanswered deadline fails the deployment", async () => {
    await mount();
    await load({ pendingPrompt: prompt(1) });
    await act(async () => {
      api.callbacks.onFailure!("Backup decision timed out");
    });
    expect(build.state.pendingPrompt).toBeNull();
    expect(build.state.deploymentFailed).toBe(true);
  });

  it("updates a decision answered in another tab even while the log stream remains connected", async () => {
    await mount();
    await load({ pendingPrompt: prompt(1) });
    expect(api.stream.isConnected).toBe(true);
    api.status.mockResolvedValue(snapshot({ pendingPrompt: prompt(2) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(build.state.pendingPrompt?.promptId).toBe("backup:2");
    api.status.mockResolvedValue(snapshot({ pendingPrompt: null }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(build.state.pendingPrompt).toBeNull();
    expect(build.state.isDeploying).toBe(true);
    api.status.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(api.status).not.toHaveBeenCalled();
  });
});

it("retries capacity admission using the draft already created by the deployment wizard", async () => {
  api.pricing.mockReturnValue(true);
  api.ensure.mockResolvedValueOnce({ success: true, project_id: "original-draft", created: true })
    .mockResolvedValue({ success: true, project_id: "original-draft", created: false });
  api.buildAccess.mockRejectedValueOnce(new ApiError(409, "Capacity required", { code: "CLOUD_CAPACITY_REQUIRED", projectId: "original-draft" }))
    .mockResolvedValue({ success: true, project_id: "original-draft", deployment_id: "recovered-deploy" });
  api.getEnv.mockResolvedValue({ data: [] });
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  await mount({ isApp: true, framework: "node", projectName: "Original draft" });
  await act(async () => { expect(await build.startDeployment()).toBeNull(); });
  const retry = api.pricing.mock.calls[0]![1] as () => Promise<void>;
  await act(async () => { await retry(); });
  expect(api.ensure.mock.calls[1]![0]).toMatchObject({ projectId: "original-draft" });
  expect(api.buildAccess.mock.calls.map(call => call[0].projectId)).toEqual(["original-draft", "original-draft"]);
  expect(navigate).toHaveBeenCalledWith("/build/recovered-deploy");
});

describe("workflow rules in the shared deployment wizard", () => {
  const actions = { mode: "actions" as const, workflowIds: ["ci"], requiredWorkflowIds: ["ci"] };
  const config: Partial<DeploymentConfig> = { owner: "acme", repo: "app", branch: "main", framework: "node", actions };

  it("saves rules for the ensured project before allowing deployment and preserves that draft on retry", async () => {
    api.ensure.mockResolvedValue({ success: true, project_id: "draft", created: true });
    api.getEnv.mockResolvedValue({ data: [] });
    api.buildAccess.mockResolvedValue({ success: true, project_id: "draft", deployment_id: "deployment" });
    api.policy.mockRejectedValueOnce(new ApiError(403, "Connect the repository's GitHub App first", { code: "ACTIONS_GITHUB_APP_REQUIRED" }));
    vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await mount(config);
    await act(async () => { expect(await build.startDeployment()).toBeNull(); });
    expect(api.policy).toHaveBeenCalledWith({ ...actions, projectId: "draft" });
    expect(api.buildAccess).not.toHaveBeenCalled();
    expect(api.toast).toHaveBeenCalledWith(expect.stringContaining("GitHub App"), "error", "Error");
    await act(async () => { await build.startDeployment(); });
    expect(api.ensure.mock.calls[1]![0]).toMatchObject({ projectId: "draft" });
    expect(api.policy).toHaveBeenCalledTimes(2);
    expect(api.policy.mock.invocationCallOrder[1]).toBeLessThan(api.buildAccess.mock.invocationCallOrder[0]!);
    expect(api.buildAccess).toHaveBeenCalledOnce();
  });

  it("saves workflow rules with configuration-only changes without creating a deployment", async () => {
    await mount({ ...config, projectId: "existing", projectEnvBaseline: [] });
    await act(async () => { expect(await build.startDeployment({ saveConfigOnly: true })).toBe("existing"); });
    expect(api.setOptions).toHaveBeenCalledOnce();
    expect(api.policy).toHaveBeenCalledWith({ ...actions, projectId: "existing" });
    expect(api.ensure).not.toHaveBeenCalled();
    expect(api.buildAccess).not.toHaveBeenCalled();
  });
});

describe("deployment counter (#919)", () => {
  it("picks up a queued build's start time even after its stream connects", async () => {
    await mount();
    await load({ status: "queued", is_active: false, buildStartedAt: null });
    expect(build.state.isDeploying).toBe(true);
    expect(clockText()).toBe("—");
    const actualStart = new Date(Date.now() + 1000).toISOString();
    api.status.mockResolvedValue(snapshot({ buildStartedAt: actualStart }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(build.state.buildStartedAt).toBe(actualStart);
    expect(clockText()).toBe("0:02");
    const reads = api.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(api.status).toHaveBeenCalledTimes(reads);
    expect(clockText()).toBe("0:11");
  });

  it.each([false, true])(
    "preserves the server's decision while loading final timing: %s",
    async (decisionPending) => {
      await mount();
      await load({
        status: "ready",
        is_active: false,
        buildDurationMs: 3500,
        decisionPending,
        warningMessage: "A domain still needs DNS changes",
      });
      expect(build.state).toMatchObject({
        deploymentSuccess: true,
        buildDurationMs: 3500,
        decisionPending,
        warningMessage: "A domain still needs DNS changes",
      });
    },
  );

  it.each(["deploymentSuccess", "deploymentFailed", "deploymentCanceled"] as const)(
    "does not turn an unknown terminal duration into days of build time: %s",
    (flag) => {
      const state = { ...INITIAL_STATE, buildStartedAt: START.toISOString(), [flag]: true };
      expect(resolveBuildElapsedMs(state, START.getTime() + 10 * 86_400_000)).toBeNull();
    },
  );

  it("keeps a recorded zero duration, and rejects non-finite durations", () => {
    expect(resolveBuildElapsedMs({ ...INITIAL_STATE, buildDurationMs: 0 })).toBe(0);
    expect(resolveBuildElapsedMs({ ...INITIAL_STATE, buildDurationMs: NaN })).toBeNull();
  });

  it("does not show a completed cancellation as Stopping again on refresh", async () => {
    await mount();
    await load({ status: "cancelled", is_active: false, buildDurationMs: 4500 });
    expect(build.state.cancellationPending).toBe(false);
    expect(build.state.failureMessage).toBe("Build was cancelled");
    expect(clockText()).toBe("0:05");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(clockText()).toBe("0:05");
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it("shows unknown for an old terminal deployment whose duration was never recorded", async () => {
    vi.setSystemTime(START.getTime() + 10 * 86_400_000);
    await mount();
    await load({ status: "failed", is_active: false });
    expect(build.state.failureMessage).toBe("Build failed");
    expect(clockText()).toBe("—");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(clockText()).toBe("—");
  });

  it("catches up after background-tab throttling using timestamps, not tick counts", async () => {
    await mount();
    await load();
    expect(clockText()).toBe("0:10");
    vi.setSystemTime(START.getTime() + 69_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(clockText()).toBe("1:10");
  });

  it.each(["onSuccess", "onFailure", "onCanceled"])(
    "freezes immediately and reconciles final server timing after %s",
    async (event) => {
      await mount();
      await load();
      let resolveStatus!: (value: unknown) => void;
      api.status.mockReturnValue(
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      );
      await act(async () => {
        api.callbacks[event](event === "onSuccess" ? {} : "Finished");
      });
      expect(build.state.buildDurationMs).toBe(10_000);
      expect(api.status).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(clockText()).toBe("0:10");
      // Even a slow status read must not overlap another one.
      expect(api.status).toHaveBeenCalledTimes(2);
      await act(async () => {
        resolveStatus(
          snapshot({
            status:
              event === "onSuccess" ? "ready" : event === "onFailure" ? "failed" : "cancelled",
            is_active: false,
            buildDurationMs: 4250,
          }),
        );
      });
      expect(build.state.buildDurationMs).toBe(4250);
      expect(build.state.cancellationPending).toBe(false);
      expect(clockText()).toBe("0:04");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(api.status).toHaveBeenCalledTimes(2);
    },
  );

  it("copies final timing when a disconnected build settles through polling", async () => {
    api.stream.isConnected = false;
    await mount();
    await load();
    api.status.mockResolvedValue(
      snapshot({
        status: "failed",
        is_active: false,
        buildDurationMs: 3000,
        buildStartedAt: new Date(START.getTime() + 1000).toISOString(),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(build.state).toMatchObject({
      deploymentFailed: true,
      isDeploying: false,
      buildDurationMs: 3000,
      buildStartedAt: new Date(START.getTime() + 1000).toISOString(),
    });
    expect(clockText()).toBe("0:03");
  });

  it("starts each retry with its own clock, without carrying an earlier attempt or idle time", async () => {
    await mount();
    await load({ status: "failed", is_active: false, buildDurationMs: 9000 });
    vi.setSystemTime(START.getTime() + 86_400_000);
    api.redeploy.mockResolvedValue({ success: true, deployment_id: "dep-new" });
    await act(async () => {
      await build.redeploy("dep-old");
    });
    expect(build.state.deploymentId).toBe("dep-new");
    expect(resolveBuildElapsedMs(build.state)).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(clockText()).toBe("0:02");
  });

  it("leaves the old deployment's time and outcome intact if retry admission fails", async () => {
    await mount();
    await load({ status: "cancelled", is_active: false, buildDurationMs: 9000 });
    api.redeploy.mockRejectedValue(
      new ApiError(409, "Conflict", { error: "The worker is still stopping" }),
    );
    await act(async () => {
      expect(await build.redeploy("dep-old")).toBeNull();
    });
    expect(build.state).toMatchObject({
      deploymentId: "dep-old",
      deploymentCanceled: true,
      deploymentFailed: false,
      buildDurationMs: 9000,
      buildStartedAt: START.toISOString(),
    });
    expect(clockText()).toBe("0:09");
  });

  it("keeps polling only while cancellation cleanup is pending, with a fixed counter", async () => {
    api.stream.isConnected = false;
    await mount();
    await load({
      status: "cancelled",
      is_active: false,
      cancellationPending: true,
      buildDurationMs: 5000,
    });
    const initialReads = api.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(api.status).toHaveBeenCalledTimes(initialReads + 3);
    expect(clockText()).toBe("0:05");
    api.status.mockResolvedValue(
      snapshot({ status: "cancelled", is_active: false, buildDurationMs: 5000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(build.state.cancellationPending).toBe(false);
    const settledReads = api.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.status).toHaveBeenCalledTimes(settledReads);
  });

  it("does not let a delayed status poll replace a new retry's state", async () => {
    api.stream.isConnected = false;
    await mount();
    await load({
      status: "cancelled",
      is_active: false,
      cancellationPending: true,
      buildDurationMs: 9000,
    });
    let resolveOld!: (value: unknown) => void;
    api.status.mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    api.redeploy.mockResolvedValue({ success: true, deployment_id: "dep-new" });
    await act(async () => {
      await build.redeploy("dep-old");
    });
    await act(async () => {
      resolveOld(snapshot({ status: "cancelled", is_active: false, buildDurationMs: 9000 }));
    });
    expect(build.state).toMatchObject({
      deploymentId: "dep-new",
      isDeploying: true,
      buildDurationMs: null,
      deploymentCanceled: false,
    });
  });

  it("ignores an older page load that completes after another deployment is loaded", async () => {
    await mount();
    let resolveOld!: (value: unknown) => void;
    api.status.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    let oldLoad!: ReturnType<typeof build.loadBuildSession>;
    await act(async () => {
      oldLoad = build.loadBuildSession("dep-old");
    });
    api.status.mockResolvedValue(
      snapshot({
        deployment_id: "dep-new",
        status: "ready",
        is_active: false,
        buildDurationMs: 3000,
      }),
    );
    await act(async () => {
      await build.loadBuildSession("dep-new");
    });
    await act(async () => {
      resolveOld(snapshot({ status: "cancelled", is_active: false, buildDurationMs: 9000 }));
      expect(await oldLoad).toEqual({ success: false, superseded: true });
    });
    expect(build.state).toMatchObject({
      deploymentId: "dep-new",
      deploymentSuccess: true,
      buildDurationMs: 3000,
    });
  });
});
