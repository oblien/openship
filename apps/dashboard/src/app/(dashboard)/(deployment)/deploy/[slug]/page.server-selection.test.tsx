// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DEFAULT_CONFIG } from "@/context/deployment/types";
import DeployRepository from "./page";

const h = vi.hoisted(() => ({ initialize: vi.fn(), toast: vi.fn(), selection: null as any }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "repository" }),
  useSearchParams: () => new URLSearchParams("branch=feature&projectId=draft"),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/utils/repoSlug", () => ({
  decodeSlug: () => ({ kind: "repo", owner: "acme", repo: "private", branch: "main" }),
}));
vi.mock("@/context/DeploymentContext", () => ({
  useDeployment: () => {
    const [config, setConfig] = useState({ ...DEFAULT_CONFIG, owner: "acme", repo: "private" });
    return {
      config,
      state: {},
      isRescanning: false,
      updateConfig: (next: object) => setConfig((previous) => ({ ...previous, ...next })),
      initializeFromRepo: h.initialize,
    };
  },
}));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/components/toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/DeployTargetStep", () => ({
  default: () => null,
  DeployTargetSummary: () => null,
}));
vi.mock("./components/ServerRuntimePicker", () => ({ useServerRuntimeSelection: () => ({}) }));
vi.mock("./components/SkeletonLoader", () => ({ default: () => <div>Loading</div> }));
vi.mock("@/components/import-project/ProjectSettings", () => ({
  default: () => <div>Project configuration</div>,
}));
vi.mock("@/components/import-project/BuildSettings", () => ({ default: () => null }));
vi.mock("@/components/import-project/DockerSettings", () => ({ default: () => null }));
vi.mock("@/components/import-project/ComposeServices", () => ({ default: () => null }));
vi.mock("@/components/import-project/ComposePathField", () => ({ ComposePathField: () => null }));
vi.mock("@/components/import-project/ConfigDiagnostics", () => ({ ConfigDiagnostics: () => null }));
vi.mock("@/components/import-project/EnvironmentVariables", () => ({ default: () => null }));
vi.mock("@/components/import-project/MonorepoApps", () => ({ default: () => null }));
vi.mock("@/components/import-project/RoutingSection", () => ({ default: () => null }));
vi.mock("@/components/project-settings/ReadinessSection", () => ({ default: () => null }));
vi.mock("@/components/actions/DeployActions", () => ({ DeployActions: () => null }));
vi.mock("@/components/import-project/DeployGitHubChecks", () => ({
  DeployGitHubChecks: () => null,
}));
vi.mock("@/components/shared/ServerSelector", () => ({
  useServerSelection: (props: any) => {
    h.selection = props;
    return {
      ready: !!props.value,
      select: () => props.onSelect({ id: "working-server", name: "Working server", raw: {} }),
    };
  },
  ServerSelectorView: ({ selection }: any) => (
    <button onClick={selection.select}>Select working server</button>
  ),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.initialize.mockResolvedValue({
    success: false,
    error: "Repository could not be read",
    errorType: "api_error",
  });
  h.initialize.mockResolvedValueOnce({
    success: false,
    error: "Select a server",
    errorType: "api_error",
    errorCode: "GITHUB_SERVER_SELECTION_REQUIRED",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("requires a user choice and retries the same source with that server, retaining recovery after another failure", async () => {
  await act(async () => root.render(<DeployRepository />));
  const retry = () =>
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent === baseDictionary.billing.plansRoute.tryAgain,
    )!;
  expect(retry().disabled).toBe(true);
  expect(h.selection.autoSelectFirst).toBe(false);
  expect(h.selection.useSavedDefault).toBe(false);
  expect(h.selection.value).toBeNull();
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Select working server")!
      .click(),
  );
  expect(retry().disabled).toBe(false);
  await act(async () => retry().click());
  expect(h.initialize).toHaveBeenLastCalledWith("acme", "private", undefined, {
    branch: "feature",
    projectId: "draft",
    serverId: "working-server",
  });
  expect(host.textContent).toContain("Repository could not be read");
  expect(host.textContent).toContain("Select working server");
  h.initialize.mockResolvedValueOnce({ success: true });
  await act(async () => retry().click());
  expect(host.textContent).toContain("Project configuration");
  expect(h.selection.selfHostedOnly).toBe(false);
  expect(h.selection.value).toBe("working-server");
});
