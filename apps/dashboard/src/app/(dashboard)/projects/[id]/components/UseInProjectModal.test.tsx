// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConnectionOutput } from "@/lib/api/apps";
import { EnvVarsEditor } from "./EnvVarsEditor";
import { ProjectConnectionForm, UseInProjectModal } from "./UseInProjectModal";

/**
 * The connect toast must stay true whether or not a redeploy started.
 *
 * Saving a connection makes the API try to redeploy a target that is already
 * deployed (trigger "service-connection"). It skips a target that was never
 * deployed, and it swallows a failed trigger. The response does not say which
 * case happened, so the copy cannot tell the user to redeploy, and it cannot
 * claim a redeploy started either. It points them at the deployment status.
 */

const h = vi.hoisted(() => ({
  getConnection: vi.fn(),
  candidates: vi.fn(),
  bundle: vi.fn(),
  showToast: vi.fn(),
  getEnv: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  trigger: vi.fn(),
}));
vi.mock("@/lib/api/apps", () => ({ appsApi: { getConnection: h.getConnection } }));
vi.mock("@/lib/api/connections", () => ({
  connectionsApi: { candidates: h.candidates, bundle: h.bundle, list: h.list, remove: h.remove },
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.showToast }) }));

vi.mock("@/lib/api", () => ({
  projectsApi: { getEnv: h.getEnv },
  deployApi: { trigger: h.trigger },
}));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({ projectData: { activeDeploymentId: "active", workspaceId: null } }),
}));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => () => false }));

const HINT =
  "If the target is already deployed, Openship tries to redeploy it right away. Save other environment changes first.";

const outputs: AppConnectionOutput[] = [
  {
    id: "dbUrl",
    service: "postgres",
    label: "Connection URL",
    value: "postgres://db:5432/app",
    secret: true,
    recommended: true,
    envKey: "DATABASE_URL",
  },
  {
    id: "host",
    service: "postgres",
    label: "Host",
    value: "db",
    secret: false,
    recommended: true,
    envKey: "DB_HOST",
  },
];

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.getConnection.mockReset().mockResolvedValue({ data: { outputs: [outputs[0]] } });
  h.candidates.mockReset();
  h.bundle.mockReset().mockResolvedValue({});
  h.showToast.mockReset();
  h.getEnv.mockReset().mockResolvedValue({ data: [] });
  h.list.mockReset().mockResolvedValue({ data: [] });
  h.remove.mockReset().mockResolvedValue({});
  h.trigger.mockReset();
  onClose.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const click = (target: HTMLElement) => act(async () => target.click());
const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  )!;
async function choose(scope: ParentNode, name: string) {
  await click(scope.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) =>
    candidate.textContent?.startsWith(name),
  );
  expect(option, name).toBeDefined();
  await click(option!);
}

describe("connection form copy", () => {
  it("names the count and project, and points at the deployment status, after sharing values", async () => {
    h.candidates.mockResolvedValue({
      data: [{ id: "web", name: "Web app", description: "production", appTemplateId: null }],
    });
    await act(async () =>
      root.render(
        <UseInProjectModal open onClose={onClose} sourceProjectId="db" outputs={outputs} />,
      ),
    );
    const dialog = document.querySelector<HTMLElement>("[data-modal-surface]")!;
    expect(dialog.textContent).toContain(HINT);

    await choose(dialog, "Web app");
    await click(button(dialog, "Connect"));

    expect(h.bundle).toHaveBeenCalledWith("web", {
      sourceProjectId: "db",
      items: [
        { outputId: "dbUrl", envKey: "DATABASE_URL" },
        { outputId: "host", envKey: "DB_HOST" },
      ],
      mode: "internal",
    });
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith(
      "Saved 2 connection value(s) for Web app. Check its deployment status.",
      "success",
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("says the connection is saved, not that the user must redeploy, after Connect existing", async () => {
    // Connect existing fixes the target. Candidates never include the target
    // itself, so the form has no target name and uses the plain toast.
    h.candidates.mockResolvedValue({
      data: [{ id: "db", name: "Postgres", description: "production", appTemplateId: "postgres" }],
    });
    await act(async () =>
      root.render(<ProjectConnectionForm targetProjectId="web" onClose={onClose} hideHeader />),
    );
    expect(host.textContent).toContain(HINT);

    await choose(host, "Postgres");
    expect(h.getConnection).toHaveBeenCalledWith("db");
    await click(button(host, "Connect"));

    expect(h.bundle).toHaveBeenCalledWith("web", {
      sourceProjectId: "db",
      items: [{ outputId: "dbUrl", envKey: "DATABASE_URL" }],
      mode: "internal",
    });
    expect(h.showToast).toHaveBeenCalledTimes(1);
    const [message, type] = h.showToast.mock.calls[0];
    expect(type).toBe("success");
    expect(message).toBe("Connection saved. Check the target's deployment status.");
    expect(message).not.toMatch(/redeploy/i);
  });
});

it("does not offer a second apply after unlinking a live connection", async () => {
  h.getEnv.mockResolvedValueOnce({
    data: [{ key: "DATABASE_URL", value: "masked", isSecret: true, environment: "production" }],
  });
  h.list.mockResolvedValueOnce({
    data: [{ id: "link", envKey: "DATABASE_URL", sourceName: "Postgres", mode: "internal" }],
  });
  await act(async () => root.render(<EnvVarsEditor projectId="web" isOpen onClose={onClose} />));
  const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes("DATABASE_URL"),
  )!;
  await click(row);
  await click(button(document, "Remove connection"));
  expect(h.remove).toHaveBeenCalledWith("web", "link");
  expect(h.showToast).toHaveBeenCalledWith(
    "Connection removed. Check the target's deployment status.",
    "success",
  );
  expect(document.body.textContent).not.toContain("Apply (restart, no rebuild)");
  expect(h.trigger).not.toHaveBeenCalled();
});
