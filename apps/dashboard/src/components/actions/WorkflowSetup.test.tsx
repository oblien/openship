// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { I18nProvider } from "@/components/i18n-provider";
import { WorkflowSetup } from "./WorkflowSetup";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  runners: vi.fn(),
  projects: vi.fn(),
  discover: vi.fn(),
  source: vi.fn(),
  preview: vi.fn(),
  write: vi.fn(),
  save: vi.fn(),
  importWorkflows: vi.fn(),
  onSaved: vi.fn(),
  channels: vi.fn(),
  saveRunner: vi.fn(),
  inspect: vi.fn(),
  repositoryChecks: vi.fn(),
}));
vi.mock("@/lib/api/actions", () => ({
  actionsApi: {
    get: h.get,
    runners: h.runners,
    projects: h.projects,
    discover: h.discover,
    repositorySource: h.source,
    preview: h.preview,
    updateRepositorySource: h.write,
    save: h.save,
    importWorkflows: h.importWorkflows,
    saveRunner: h.saveRunner,
    inspectDestination: h.inspect,
    repositoryChecks: h.repositoryChecks,
  },
}));
vi.mock("@/lib/api/notifications", () => ({ notificationsApi: { listChannels: h.channels } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/shared/ServerSelector", () => ({
  default: ({ onSelect }: { onSelect: (server: { id: string; name: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ id: "build-server", name: "Build server" })}>
      Use build server
    </button>
  ),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: "org" } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "local" }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, cloudAuthUrl: "https://app.openship.io" }),
}));
vi.mock("@/components/servers/add-server-modal", () => ({ useAddServerModal: () => vi.fn() }));
vi.mock("@/components/github/RepositoryPicker", () => ({ RepositoryPicker: () => null }));
vi.mock("@/components/github/RepositoryBranchSelect", () => ({
  RepositoryBranchSelect: () => <span>main</span>,
}));
vi.mock("@/components/backup/BackupDestinationSelect", () => ({
  BackupDestinationSelect: () => null,
}));
vi.mock("./WorkflowGraph", () => ({
  WorkflowGraph: ({
    plan,
    editor,
    jobDetails,
  }: {
    plan: { jobs: Array<{ id: string; name: string }> };
    editor: { onSelect: (value: { kind: "node"; id: string }) => void };
    jobDetails: { expandedJobs: string[] };
  }) => (
    <div>
      Workflow topology
      {plan.jobs.map((job) => (
        <div key={job.id}>
          <button
            aria-label={`Edit job: ${job.name}`}
            onClick={() => editor.onSelect({ kind: "node", id: job.id })}
          >
            {job.name}
          </button>
          {jobDetails.expandedJobs.includes(job.id) && <span data-visible-steps={job.id} />}
        </div>
      ))}
    </div>
  ),
}));

const source =
  "# keep this comment\nname: CI\non: [push, workflow_dispatch]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo tested\n";
const plan = {
  name: "CI",
  triggers: ["push", "workflow_dispatch"],
  triggerRules: { push: {}, workflow_dispatch: {} },
  inputs: [],
  jobs: [{ id: "test", name: "test", needs: [], runsOn: "ubuntu-latest", requiresDocker: false }],
};
let root: Root;
let host: HTMLDivElement;
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
  )!;
const click = (name: string) => act(async () => button(name).click());
async function selectRunner(name = "Linux runner") {
  await click("Allowed runners");
  await act(async () => checkbox(name).click());
  await click("Use selected runners");
}
async function chooseTriggerFile(name: string) {
  await click("Workflow file");
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (option) => option.textContent?.startsWith(name),
  )!;
  await act(async () => option.click());
  await preview();
}
const checkbox = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`) ??
  document.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="${name}"]`) ??
  [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((label) => label.textContent?.startsWith(name))!
    .querySelector<HTMLButtonElement>('[role="checkbox"]')!;
async function chooseAccess(label: string, option: string) {
  await click(label);
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === option,
  )!;
  await act(async () => item.click());
}
function expectSecureDefaults() {
  expect(button("Who can run").textContent).toContain("Only my account");
  expect(button("Run approval").textContent).toContain("Approve each run");
  expect(button("Fork pull requests").textContent).toContain("Block fork runs");
  expect(host.textContent).not.toContain("Allow workflows in this repository");
}
async function fill(label: string, text: string) {
  const input =
    document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`) ??
    [...document.querySelectorAll<HTMLLabelElement>("label")]
      .find((row) => !row.closest("[hidden]") && row.firstElementChild?.textContent === label)!
      .querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const preview = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
async function editYaml(value: string) {
  const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Workflow YAML"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await preview();
}
async function render(id?: string) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <WorkflowSetup id={id} onSaved={h.onSaved} onCancel={() => {}} />
      </I18nProvider>,
    ),
  );
  await preview();
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  h.repositoryChecks.mockResolvedValue({
    repository: "acme/app",
    account: { login: "owner", avatarUrl: "", kind: "account" },
    status: "connected",
  });
  vi.useFakeTimers();
  const workflow = {
    id: "ci",
    controller: "openship",
    name: "CI",
    owner: "acme",
    repo: "app",
    ref: "main",
    path: ".openship/workflows/ci.yml",
    source: null,
    plan,
    runnerIds: ["linux"],
    projectIds: ["project"],
    enabled: true,
    variables: {},
    secretNames: [],
    allowForks: false,
    storageDestinationId: null,
  };
  h.get.mockResolvedValue(workflow);
  h.runners.mockResolvedValue([
    {
      id: "linux",
      name: "Linux runner",
      kind: "server",
      labels: ["self-hosted", "linux"],
      enabled: true,
      capabilities: {
        os: "linux",
        architecture: "x64",
        docker: true,
        git: true,
        node: true,
        distribution: null,
        version: null,
      },
      config: {
        mode: "container",
        image: "node:22",
        labels: [],
        cpu: 1,
        memoryMb: 2048,
        maxParallel: 1,
        allowDockerSocket: false,
      },
    },
  ]);
  h.projects.mockResolvedValue([{ id: "project", name: "Storefront" }]);
  h.channels.mockResolvedValue({
    channels: [{ id: "ops", label: "Ops email", kind: "email", verified: true, enabled: true }],
  });
  h.inspect.mockResolvedValue({
    os: "linux",
    architecture: "x64",
    docker: true,
    git: true,
    node: true,
  });
  h.saveRunner.mockImplementation(async (input) => ({
    ...input,
    id: "new-runner",
    kind: "server",
    capabilities: await h.inspect(),
    labels: ["self-hosted", "linux"],
  }));
  h.discover.mockResolvedValue([{ path: workflow.path, name: "ci.yml" }]);
  h.source.mockResolvedValue({ source, sha: "original-file-sha", plan, error: null });
  h.preview.mockImplementation(async (yaml) => {
    const value = parse(yaml);
    return {
      ...plan,
      name: value.name ?? "Workflow",
      jobs: Object.entries(value.jobs).map(([id, raw]) => {
        const job = raw as Record<string, unknown>;
        return {
          id,
          name: job.name || id,
          needs: typeof job.needs === "string" ? [job.needs] : (job.needs ?? []),
          runsOn: job["runs-on"],
          uses: job.uses,
          requiresDocker: false,
        };
      }),
    };
  });
  h.write.mockResolvedValue({ sha: "new-file-sha", commit: "commit" });
  h.save.mockImplementation(async (input, id) => ({ ...workflow, ...input, id: id ?? "created" }));
  h.importWorkflows.mockImplementation(async (inputs) =>
    inputs.map((input: object, index: number) => ({
      ...workflow,
      ...input,
      id: `imported-${index}`,
    })),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("shared workflow setup", () => {
  it("creates a custom workflow with its YAML name without requiring a hidden name edit", async () => {
    await render();
    await click("Use a custom workflow instead");
    await preview();
    expect(button("Standalone").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector<HTMLInputElement>('input[id$="-name"]')!.value).toBe("Automation");
    await click("Continue");
    await selectRunner();
    await click("Continue");
    await click("Continue");
    expect(button("Save workflow").disabled).toBe(false);
    await click("Save workflow");
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Automation",
        owner: null,
        repo: null,
        source: expect.stringContaining("name: Automation"),
        runnerIds: ["linux"],
        accessPolicy: { audience: "owner", users: [], approval: "required", forks: "deny" },
      }),
      undefined,
    );
    expect(h.onSaved).toHaveBeenCalledOnce();
    expect(h.importWorkflows).not.toHaveBeenCalled();
  });

  it("explains a cleared name on Checks and returns to its input without overwriting the edit", async () => {
    await render();
    await click("Use a custom workflow instead");
    await preview();
    await fill("Name", "");
    await click("YAML");
    await editYaml(
      "name: Another name\non: workflow_dispatch\njobs:\n  run:\n    runs-on: linux\n    steps:\n      - run: echo changed\n",
    );
    expect(host.querySelector<HTMLInputElement>('input[id$="-name"]')!.value).toBe("");
    await click("Run settings");
    await selectRunner();
    await click("Checks");
    const save = button("Save workflow");
    expect(save.disabled).toBe(true);
    expect(document.getElementById(save.getAttribute("aria-describedby")!)!.textContent).toContain(
      "Add a workflow name",
    );
    await click("Add a workflow name");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(button("Workflow").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(host.querySelector('input[id$="-name"]'));
    await fill("Name", "My custom workflow");
    await click("Checks");
    expect(button("Save workflow").disabled).toBe(false);
    await click("Save workflow");
    expect(h.save.mock.calls[0]![0].name).toBe("My custom workflow");
  });

  it("explains missing runners on Checks and links back to destination selection", async () => {
    await render();
    await click("Standalone");
    await preview();
    await click("Checks");
    expect(button("Save workflow").disabled).toBe(true);
    await click("Select at least one runner");
    expect(button("Run settings").getAttribute("aria-selected")).toBe("true");
    await selectRunner();
    expect(host.textContent).not.toContain("Select at least one runner");
    expect(button("Save workflow").disabled).toBe(false);
  });

  it("explains an incomplete repository even when Run settings is opened directly", async () => {
    await render();
    await click("Run settings");
    expect(button("Continue").disabled).toBe(true);
    await click("Choose a repository or use a custom workflow");
    expect(button("Workflow").getAttribute("aria-selected")).toBe("true");
    expect(button("Use a custom workflow instead")).toBeDefined();
  });

  it("requires an included file and restores saving after the checklist is corrected", async () => {
    await selectFiles();
    await click("Workflow");
    await click("Clear");
    await click("Checks");
    expect(button("Save workflow").disabled).toBe(true);
    await click("Select at least one workflow file");
    expect(button("Workflow").getAttribute("aria-selected")).toBe("true");
    await click("Select all");
    expect(button("Save 2 workflows").disabled).toBe(false);
    await click("Save 2 workflows");
    expect(h.importWorkflows).toHaveBeenCalledOnce();
  });

  it("keeps save blocked while checking a changed draft and exposes a retryable validation error", async () => {
    await render();
    await click("Standalone");
    await preview();
    await click("Run settings");
    await selectRunner();
    await click("Checks");
    await click("YAML");
    let rejectPreview!: (error: Error) => void;
    h.preview.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectPreview = reject;
        }),
    );
    await editYaml(
      "name: Automation\non: workflow_dispatch\njobs:\n  run:\n    runs-on: linux\n    steps:\n      - run: echo changed\n",
    );
    expect(button("Save workflow").disabled).toBe(true);
    expect(host.textContent).toContain("Checking workflow…");
    await act(async () => rejectPreview(new Error("Validation service unavailable")));
    expect(host.textContent).toContain("Validation service unavailable");
    expect(button("Save workflow").disabled).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
    await click("Review the workflow validation error");
    expect(button("Workflow").getAttribute("aria-selected")).toBe("true");
    expect(button("YAML").getAttribute("aria-selected")).toBe("true");
    expect(button("Save workflow").disabled).toBe(false);
    await click("Save workflow");
    expect(h.save).toHaveBeenCalledOnce();
  });

  it("keeps the current project implicit and creates a required runner without leaving the draft", async () => {
    h.runners.mockResolvedValue([]);
    await act(async () =>
      root.render(
        <I18nProvider>
          <WorkflowSetup
            initial={{ projectId: "project" }}
            onSaved={h.onSaved}
            onCancel={() => {}}
          />
        </I18nProvider>,
      ),
    );
    await click("Standalone");
    await fill("Name", "Project checks");
    await preview();
    await click("Continue");
    expect(host.textContent).not.toContain("Linked projects");
    expect(h.projects).not.toHaveBeenCalled();
    expect(button("Continue").disabled).toBe(true);
    await click("Allowed runners");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Add runner",
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[value="existing"]')!.click(),
    );
    await click("Use build server");
    await click("Verify and save runner");
    expect(h.saveRunner).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain("Build server");
    await click("Continue");
    expect(button("Access").getAttribute("aria-selected")).toBe("true");
    await click("Continue");
    await act(async () => checkbox("Ops email").click());
    await click("Save workflow");
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Project checks",
        projectIds: ["project"],
        runnerIds: ["new-runner"],
        notifications: { channels: ["ops"], events: ["failure"] },
      }),
      undefined,
    );
  });

  it("preserves hidden project links on existing workflows and saves notification choices", async () => {
    await act(async () =>
      root.render(
        <I18nProvider>
          <WorkflowSetup
            id="ci"
            initial={{ projectId: "project" }}
            onSaved={h.onSaved}
            onCancel={() => {}}
          />
        </I18nProvider>,
      ),
    );
    await preview();
    await click("Run settings");
    expect(host.textContent).not.toContain("Linked projects");
    await click("Checks");
    expect(host.textContent).toContain("acme/app");
    expect(host.textContent).toContain("Connected");
    await act(async () => checkbox("Succeeded").click());
    await act(async () => checkbox("Ops email").click());
    await click("Save workflow");
    expect(h.save.mock.calls[0]![0]).not.toHaveProperty("projectIds");
    expect(h.save.mock.calls[0]![0].notifications).toEqual({
      channels: ["ops"],
      events: ["failure", "success"],
    });
  });

  it("keeps the draft when runner setup is cancelled and requires a destination", async () => {
    h.runners.mockResolvedValue([]);
    await render();
    await click("Standalone");
    await fill("Name", "Keep this draft");
    await preview();
    await click("Continue");
    await click("Allowed runners");
    const cancel = [
      ...document.querySelector('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Cancel")!;
    await act(async () => cancel.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Continue").disabled).toBe(true);
    await click("Workflow");
    expect(
      [...document.querySelectorAll<HTMLInputElement>("input")].some(
        (input) => input.value === "Keep this draft",
      ),
    ).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  async function selectFiles(directory = ".github/workflows") {
    const files = ["build", "test"].map((name) => ({
      path: `${directory}/${name}.yml`,
      name: `${name}.yml`,
    }));
    h.discover.mockResolvedValue(files);
    await render();
    await fill("Repository", "acme/app");
    await preview();
    await click("Select all");
    await click("Continue");
    await selectRunner();
    await click("Checks");
    await click("Workflow");
    return files;
  }

  it("keeps each file's automatic or reviewed update policy while importing together", async () => {
    const files = await selectFiles(".openship/workflows");
    await click("Review first");
    await click("test.yml");
    await preview();
    expect(button("Automatic").getAttribute("aria-selected")).toBe("true");
    await click("build.yml");
    await preview();
    expect(button("Review first").getAttribute("aria-selected")).toBe("true");
    await click("Save 2 workflows");
    expect(h.importWorkflows).toHaveBeenCalledWith([
      expect.objectContaining({ path: files[0]!.path, source }),
      expect.objectContaining({ path: files[1]!.path, source: null }),
    ]);
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each([".github/workflows", ".openship/workflows"])(
    "keeps manual, main-only push and PR triggers separate while editing a batch from Run settings (%s)",
    async (directory) => {
      const files = ["manual", "push", "pr"].map((name) => ({
        path: `${directory}/${name}.yml`,
        name: `${name}.yml`,
      }));
      const sources = [
        "on: workflow_dispatch",
        "on:\n  push:\n    branches: [main]\n    paths: [src/**]",
        "on: pull_request",
      ].map((trigger) => source.replace("on: [push, workflow_dispatch]", trigger));
      h.discover.mockResolvedValue(files);
      h.source.mockImplementation(async ({ path }) => ({
        source: sources[files.findIndex((file) => file.path === path)],
        sha: `${path}-sha`,
        plan,
        error: null,
      }));
      await render();
      await fill("Repository", "acme/app");
      await preview();
      await click("Select all");
      await click("Continue");
      await selectRunner();
      const expectEvents = (manual: boolean, push: boolean, pr: boolean) => {
        for (const [label, checked] of [
          ["Manual & Jobs", manual],
          ["Git push", push],
          ["Pull request", pr],
        ] as const)
          expect(checkbox(label).getAttribute("aria-checked")).toBe(String(checked));
      };
      expectEvents(true, false, false);
      await chooseTriggerFile("push.yml");
      expectEvents(false, true, false);
      expect(button("Git push").textContent).toContain("Branches: main");
      expect(button("Git push").textContent).toContain("Paths: src/**");
      await click("Git push");
      await fill("Branches", "release/**");
      await act(async () =>
        document
          .querySelector<HTMLInputElement>('input[aria-label="Branches"]')!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      await preview();
      await chooseTriggerFile("pr.yml");
      expectEvents(false, false, true);
      await chooseTriggerFile("manual.yml");
      expectEvents(true, false, false);
      await chooseTriggerFile("push.yml");
      expect(button("Git push").textContent).toContain("Branches: main, release/**");
      await click("Continue");
      await click("Continue");
      await click("Save 3 workflows");
      await click(directory === ".github/workflows" ? "Commit and save" : "Save Openship copy");
      const inputs = h.importWorkflows.mock.calls[0]![0];
      expect(inputs.map((input: { path: string }) => input.path)).toEqual(
        files.map((file) => file.path),
      );
      let changed: string;
      if (directory === ".github/workflows") {
        expect(h.write).toHaveBeenCalledOnce();
        expect(h.write.mock.calls[0]![0].path).toBe(files[1]!.path);
        changed = h.write.mock.calls[0]![0].source;
        expect(inputs.map((input: { source: string | null }) => input.source)).toEqual([
          null,
          null,
          null,
        ]);
      } else {
        expect(h.write).not.toHaveBeenCalled();
        expect(inputs[0].source).toBeNull();
        expect(inputs[2].source).toBeNull();
        changed = inputs[1].source;
      }
      expect(parse(changed).on).toEqual({
        push: { branches: ["main", "release/**"], paths: ["src/**"] },
      });
      expect(parse(changed).jobs).toEqual(parse(source).jobs);
    },
    // This exercises several complete file drafts and both save/review flows.
    // Loaded CI workers need more than the default 5s for the real React updates.
    15_000,
  );

  it("keeps the file picker available without showing another file's triggers during loading", async () => {
    await selectFiles();
    await click("Run settings");
    let resolveSource!: (value: unknown) => void;
    h.source.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSource = resolve;
        }),
    );
    await chooseTriggerFile("test.yml");
    expect(button("Workflow file").textContent).toContain("test.yml");
    expect(
      document.querySelector('[role="status"][aria-label="Loading workflow…"]'),
    ).not.toBeNull();
    expect(document.querySelector('[role="switch"][aria-label="Git push"]')).toBeNull();
    await act(async () =>
      resolveSource({
        source: source.replace("on: [push, workflow_dispatch]", "on: pull_request"),
        sha: "test-sha",
        plan,
        error: null,
      }),
    );
    await preview();
    expect(checkbox("Git push").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Pull request").getAttribute("aria-checked")).toBe("true");
  });

  it("opens Run settings for an included file after previewing an excluded one", async () => {
    const files = await selectFiles();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[role="checkbox"][aria-label="Include workflow: build.yml"]',
        )!
        .click(),
    );
    await click("build.yml");
    await preview();
    await click("Run settings");
    await preview();
    expect(host.textContent).toContain(files[1]!.path);
    expect(host.textContent).not.toContain(files[0]!.path);
    await click("Save workflow");
    expect(
      h.importWorkflows.mock.calls[0]![0].map((input: { path: string }) => input.path),
    ).toEqual([files[1]!.path]);
    expect(h.write).not.toHaveBeenCalled();
  });

  it("validates offscreen drafts before committing any selected file", async () => {
    const files = await selectFiles();
    await click("YAML");
    await editYaml("jobs: [");
    await click("test.yml");
    await preview();
    await editYaml(source.replace("echo tested", "echo valid-change"));
    await click("Save 2 workflows");
    expect(host.textContent).toContain(files[0]!.path);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.importWorkflows).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("retries a partly committed import without committing successful files twice", async () => {
    const files = await selectFiles();
    await click("YAML");
    await editYaml(source.replace("echo tested", "echo build-updated"));
    await click("test.yml");
    await preview();
    await editYaml(source.replace("echo tested", "echo test-updated"));
    h.write.mockResolvedValueOnce({ sha: "build-updated-sha", commit: "build-commit" });
    h.write.mockRejectedValueOnce(new Error("Temporary repository failure"));
    await click("Save 2 workflows");
    await click("Commit and save");
    expect(h.importWorkflows).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Temporary repository failure",
    );
    await click("Commit and save");
    expect(h.write.mock.calls.map(([input]) => input.path)).toEqual([
      files[0]!.path,
      files[1]!.path,
      files[1]!.path,
    ]);
    expect(h.importWorkflows).toHaveBeenCalledOnce();
    expect(h.onSaved.mock.calls[0]![1]).toHaveLength(2);
  });

  it("selects all repository files, preserves each draft and saves every project link together", async () => {
    const files = ["build", "test"].map((name) => ({
      path: `.github/workflows/${name}.yml`,
      name: `${name}.yml`,
    }));
    h.discover.mockResolvedValue(files);
    h.source.mockImplementation(async ({ path }) => {
      const name = path.includes("build") ? "Build" : "Test";
      return {
        source: source.replace("name: CI", `name: ${name}`),
        sha: `${name}-sha`,
        plan: { ...plan, name },
        error: null,
      };
    });
    await render();
    await fill("Repository", "acme/app");
    await preview();
    await click("Select all");
    await click("Continue");
    await selectRunner();
    await act(async () => checkbox("Storefront").click());
    await click("Git push");
    await fill("Branches", "release/**");
    const branch = document.querySelector<HTMLInputElement>('input[aria-label="Branches"]')!;
    await act(async () =>
      branch.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await preview();
    await click("Workflow");
    await click("test.yml");
    await preview();
    await fill("Name", "Tests on our runners");
    await click("build.yml");
    await preview();
    await click("Run settings");
    await click("Git push");
    expect(host.textContent).toContain("release/**");
    await click("Continue");
    await click("Continue");
    await click("Save 2 workflows");
    expect(h.write).not.toHaveBeenCalled();
    await click("Commit and save");
    expect(h.write).toHaveBeenCalledOnce();
    expect(parse(h.write.mock.calls[0]![0].source).on.push.branches).toEqual(["release/**"]);
    expect(h.importWorkflows).toHaveBeenCalledOnce();
    expect(h.importWorkflows.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        path: files[0]!.path,
        name: "Build",
        projectIds: ["project"],
        runnerIds: ["linux"],
        source: null,
      }),
      expect.objectContaining({
        path: files[1]!.path,
        name: "Tests on our runners",
        projectIds: ["project"],
        runnerIds: ["linux"],
        source: null,
      }),
    ]);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.onSaved.mock.calls[0]![1]).toHaveLength(2);
  });

  it("keeps pattern commas and removes chips without changing jobs or other trigger filters", async () => {
    h.source.mockResolvedValue({
      source: source.replace(
        "on: [push, workflow_dispatch]",
        "on:\n  push:\n    branches-ignore: [draft/**]\n    tags: [v*]\n  workflow_dispatch: {}",
      ),
      sha: "original-file-sha",
      plan,
      error: null,
    });
    await render("ci");
    await click("Run settings");
    await click("Git push");
    await fill("Branches", "feature/{a,b}/**");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Branches"]')!;
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Remove: draft/**"]')!.click(),
    );
    await preview();
    await click("Save workflow");
    await click("Save Openship copy");
    const yaml = parse(h.save.mock.calls[0]![0].source);
    expect(yaml.on.push).toEqual({ "branches-ignore": ["feature/{a,b}/**"], tags: ["v*"] });
    expect(yaml.jobs).toEqual(parse(source).jobs);
  });

  it("shows a single job's steps immediately and honors an explicit collapse across views", async () => {
    await render("ci");
    expect(host.querySelector('[data-visible-steps="test"]')).not.toBeNull();
    await click("Collapse all");
    expect(host.querySelector("[data-visible-steps]")).toBeNull();
    await click("YAML");
    await click("Topology");
    await preview();
    expect(host.querySelector("[data-visible-steps]")).toBeNull();
    await click("Expand all");
    expect(host.querySelector('[data-visible-steps="test"]')).not.toBeNull();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("keeps the initial job's steps open when another job is added", async () => {
    await render("ci");
    expect(host.querySelector('[data-visible-steps="test"]')).not.toBeNull();
    await click("Add job");
    await preview();
    expect(host.querySelector('[data-visible-steps="test"]')).not.toBeNull();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("expands and collapses every job from the toolbar in topology and list views", async () => {
    const multiple =
      source + "  docs:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo docs\n";
    h.source.mockResolvedValue({ source: multiple, sha: "original-file-sha", plan, error: null });
    await render("ci");
    expect(host.querySelector("[data-visible-steps]")).toBeNull();
    await click("Expand all");
    expect(
      [...host.querySelectorAll("[data-visible-steps]")].map((node) =>
        node.getAttribute("data-visible-steps"),
      ),
    ).toEqual(["test", "docs"]);
    await click("Collapse all");
    expect(host.querySelector("[data-visible-steps]")).toBeNull();
    await click("List");
    await click("Expand all");
    expect(host.querySelectorAll('[data-testid="workflow-steps"]')).toHaveLength(2);
    await click("Collapse all");
    expect(host.querySelectorAll('[data-testid="workflow-steps"]')).toHaveLength(0);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  async function repositoryWorkflow(controller = "github") {
    const path = ".github/workflows/ci.yml";
    h.get.mockResolvedValue({ ...(await h.get()), path, controller, githubWorkflowId: "42" });
    h.discover.mockResolvedValue([{ path, name: "ci.yml" }]);
  }
  async function editTrigger() {
    await render("ci");
    expect(host.textContent).toContain("Workflow topology");
    await click("Run settings");
    await act(async () => checkbox("Webhook").click());
    for (const value of ["release", "publish"]) {
      await fill("Event types", value);
      await act(async () =>
        document
          .querySelector<HTMLInputElement>('input[aria-label="Event types"]')!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
    }
    await preview();
    await click("Save workflow");
  }
  it("requires review before repository changes and can save an independent copy", async () => {
    await editTrigger();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Review workflow changes",
    );
    expect(h.write).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    await click("Save Openship copy");
    expect(h.write).not.toHaveBeenCalled();
    const [saved, id] = h.save.mock.calls[0]!;
    expect(id).toBe("ci");
    expect(saved).toMatchObject({ runnerIds: ["linux"] });
    expect(saved).not.toHaveProperty("projectIds");
    expect(parse(saved.source).on.repository_dispatch.types).toEqual(["release", "publish"]);
    expect(parse(saved.source).jobs).toEqual(parse(source).jobs);
    expect(saved.source).toContain("# keep this comment");
  });
  it("requires a repository commit for GitHub-owned workflows and never saves an override", async () => {
    await repositoryWorkflow();
    await editTrigger();
    expect(button("Save Openship copy")).toBeUndefined();
    expect(h.save).not.toHaveBeenCalled();
    await click("Commit and save");
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".github/workflows/ci.yml", sha: "original-file-sha" }),
    );
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ".github/workflows/ci.yml",
        source: null,
        accessPolicy: { audience: "owner", users: [], approval: "required", forks: "deny" },
        storageDestinationId: null,
        variables: {},
        secrets: {},
      }),
      "ci",
    );
    expect(h.onSaved).toHaveBeenCalledOnce();
  });
  it("replaces blanket runner consent with secure Access & approvals defaults", async () => {
    await repositoryWorkflow();
    await render();
    await fill("Repository", "acme/app");
    await preview();
    expect(button("GitHub Actions")).toBeUndefined();
    expect(button("Openship Actions")).toBeUndefined();
    await click("Continue");
    await selectRunner();
    await click("Continue");
    expect(button("Access").getAttribute("aria-selected")).toBe("true");
    expectSecureDefaults();
    expect(
      host.querySelector('a[href="https://github.com/acme/app/settings/actions"]'),
    ).not.toBeNull();
    expect(h.importWorkflows).not.toHaveBeenCalled();
    await click("Continue");
    await click("Save workflow");
    expect(h.importWorkflows).toHaveBeenCalledWith([
      expect.objectContaining({
        path: ".github/workflows/ci.yml",
        source: null,
        accessPolicy: { audience: "owner", users: [], approval: "required", forks: "deny" },
      }),
    ]);
    expect(h.write).not.toHaveBeenCalled();
  });
  it("returns to an incomplete selected-user policy before saving from Checks", async () => {
    await repositoryWorkflow();
    await render();
    await fill("Repository", "acme/app");
    await preview();
    await click("Continue");
    await selectRunner();
    await click("Continue");
    await chooseAccess("Who can run", "Selected GitHub users");
    expect(button("Continue").disabled).toBe(true);
    await click("Checks");
    expect(button("Save workflow").disabled).toBe(true);
    await click("Add 1–30 valid GitHub usernames.");
    expect(button("Access").getAttribute("aria-selected")).toBe("true");
    expect(h.importWorkflows).not.toHaveBeenCalled();
    await fill("GitHub users", "@octocat");
    await act(async () =>
      document
        .querySelector('input[aria-label="GitHub users"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await chooseAccess("Run approval", "Automatically allow eligible users");
    await click("Save workflow");
    expect(h.importWorkflows).toHaveBeenCalledWith([
      expect.objectContaining({
        accessPolicy: {
          audience: "selected",
          users: ["octocat"],
          approval: "automatic",
          forks: "deny",
        },
        runnerIds: ["linux"],
      }),
    ]);
  });
  it("discovers reusable repository workflows even when the saved controller was independent", async () => {
    await repositoryWorkflow("openship");
    const reusable =
      "name: CI\non: [push, workflow_dispatch]\njobs:\n  gate:\n    uses: ./.github/workflows/shared.yml\n    secrets: inherit\n";
    h.source.mockResolvedValue({ source: reusable, sha: "original-file-sha", plan, error: null });
    await render("ci");
    expect(h.source).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".github/workflows/ci.yml" }),
    );
    expect(h.source.mock.calls.at(-1)![0]).not.toHaveProperty("controller");
    expect(h.preview).toHaveBeenLastCalledWith(reusable, ".github/workflows/ci.yml");
    expect(host.textContent).toContain("gate");
    expect(button("GitHub Actions")).toBeUndefined();
    await click("Save workflow");
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        source: null,
        accessPolicy: { audience: "owner", users: [], approval: "required", forks: "deny" },
      }),
      "ci",
    );
    expect(h.save.mock.calls[0]![0]).not.toHaveProperty("controller");
    expect(h.write).not.toHaveBeenCalled();
  });
  it("restores repository discovery after switching back from standalone", async () => {
    await repositoryWorkflow();
    await render();
    await fill("Repository", "acme/app");
    await preview();
    await click("Standalone");
    await preview();
    expect(h.preview.mock.calls.at(-1)![1]).toBe(".openship/workflows/automation.yml");
    await click("Repository");
    await preview();
    expect(h.preview).toHaveBeenLastCalledWith(source, ".github/workflows/ci.yml");
    await click("Continue");
    await selectRunner();
    await click("Continue");
    expectSecureDefaults();
  });
  it("resets access for a different repository and preserves it when changing runners", async () => {
    await repositoryWorkflow();
    h.get.mockResolvedValue({
      ...(await h.get()),
      accessPolicy: {
        version: 1,
        audience: "owner",
        owner: { provider: "github", id: "42", login: "saved-owner" },
        users: [],
        approval: "required",
        forks: "deny",
      },
    });
    await render("ci");
    await click("Access");
    expect(button("Who can run").textContent).toContain("Only saved-owner");
    await chooseAccess("Run approval", "Automatically allow eligible users");
    await click("Workflow");
    await fill("Repository", "acme/other");
    await preview();
    await click("Access");
    expectSecureDefaults();
    await chooseAccess("Run approval", "Automatically allow eligible users");
    await click("Run settings");
    await click("Allowed runners");
    await act(async () => checkbox("Linux runner").click());
    await act(async () => checkbox("Linux runner").click());
    await click("Use selected runners");
    await click("Access");
    expect(button("Run approval").textContent).toContain("Automatically allow eligible users");
  });
  it("preserves edits after a concurrent GitHub change and never saves a false repository reference", async () => {
    h.write.mockRejectedValueOnce(
      new Error("The file changed on GitHub. Reload before committing."),
    );
    await editTrigger();
    await click("Commit and save");
    expect(h.save).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "The file changed on GitHub",
    );
    await click("Commit and save");
    expect(h.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ sha: "original-file-sha", ref: "main" }),
    );
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ source: null }), "ci");
    expect(h.onSaved).toHaveBeenCalledOnce();
  });
  it("edits a selected job and preserves its draft when switching topology, list and YAML", async () => {
    await render("ci");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Edit job: test"]')!.click(),
    );
    expect(
      document.querySelector('[aria-label="Job settings"]')!.getAttribute("aria-expanded"),
    ).toBe("true");
    await fill("Name", "Unit checks");
    await preview();
    await click("List");
    expect(host.textContent).toContain("Unit checks");
    await click("YAML");
    expect(
      document.querySelector<HTMLTextAreaElement>('[aria-label="Workflow YAML"]')!.value,
    ).toContain("Unit checks");
    await click("Topology");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click(),
    );
    await preview();
    expect(host.textContent).not.toContain("Unit checks");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Redo"]')!.click(),
    );
    await preview();
    await click("Save workflow");
    expect(h.write).not.toHaveBeenCalled();
    await click("Save Openship copy");
    expect(parse(h.save.mock.calls[0]![0].source).jobs.test.name).toBe("Unit checks");
  });

  it("edits each step inline only in the active view and preserves it when moving to the topology inspector", async () => {
    await render("ci");
    await click("List");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Edit job: test"]')!.click(),
    );
    const workspace = host.querySelector('[data-testid="workflow-workspace"]')!;
    const inspector = host.querySelector('[data-testid="workflow-inspector"]')!;
    expect(workspace.querySelectorAll('[data-testid="workflow-steps"]')).toHaveLength(1);
    expect(inspector.querySelector('[data-testid="workflow-steps"]')).toBeNull();
    expect(
      workspace.querySelector('[aria-label="Job settings"]')!.getAttribute("aria-expanded"),
    ).toBe("false");
    const step = [...workspace.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("echo tested"),
    )!;
    await act(async () => step.click());
    const command = workspace.querySelector<HTMLTextAreaElement>('[aria-label="Command"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        command,
        "echo updated",
      );
      command.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await preview();
    await click("Topology");
    expect(workspace.querySelector('[data-testid="workflow-steps"]')).toBeNull();
    expect(inspector.querySelectorAll('[data-testid="workflow-steps"]')).toHaveLength(1);
    expect(inspector.querySelector<HTMLTextAreaElement>('[aria-label="Command"]')!.value).toBe(
      "echo updated",
    );
    expect(
      inspector.querySelector('[aria-label="Job settings"]')!.getAttribute("aria-expanded"),
    ).toBe("true");
    await click("YAML");
    expect(
      document.querySelector<HTMLTextAreaElement>('[aria-label="Workflow YAML"]')!.value,
    ).toContain("echo updated");
    expect(h.save).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("keeps jobs and steps independently expanded through reordering, removal and view switches", async () => {
    const expandedSource =
      source.replace(
        "      - run: echo tested",
        "      - run: echo first\n      - run: echo middle\n      - run: echo last",
      ) + "  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo other\n";
    h.source.mockResolvedValue({
      source: expandedSource,
      sha: "original-file-sha",
      plan,
      error: null,
    });
    await render("ci");
    await click("List");
    const jobButton = (name: string) =>
      host.querySelector<HTMLButtonElement>(`[aria-label="Edit job: ${name}"]`)!;
    await act(async () => jobButton("test").click());
    await act(async () => jobButton("other").click());
    expect(jobButton("test").getAttribute("aria-expanded")).toBe("true");
    expect(jobButton("other").getAttribute("aria-expanded")).toBe("true");
    const workspace = host.querySelector('[data-testid="workflow-workspace"]')!;
    const lists = () => workspace.querySelectorAll('[data-testid="workflow-steps"]');
    const step = (list: number, index: number) =>
      lists()[list].querySelector<HTMLElement>(`[data-step-index="${index}"]`)!;
    const toggle = (list: number, index: number) =>
      act(async () => step(list, index).querySelector<HTMLButtonElement>("button")!.click());
    await toggle(0, 0);
    await toggle(0, 2);
    await toggle(1, 0);
    const commands = (list: number) =>
      [...lists()[list].querySelectorAll<HTMLTextAreaElement>('[aria-label="Command"]')].map(
        (input) => input.value,
      );
    expect(commands(0)).toEqual(["echo first", "echo last"]);
    expect(commands(1)).toEqual(["echo other"]);
    await act(async () =>
      step(0, 2).querySelector<HTMLButtonElement>('[aria-label="Move step up"]')!.click(),
    );
    await preview();
    expect(commands(0)).toEqual(["echo first", "echo last"]);
    expect(step(0, 1).querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    expect(step(0, 2).querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    await act(async () =>
      [...step(0, 0).querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Remove")!
        .click(),
    );
    await preview();
    expect(commands(0)).toEqual(["echo last"]);
    expect(commands(1)).toEqual(["echo other"]);
    await click("Topology");
    await act(async () => jobButton("test").click());
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Command"]')!.value).toBe(
      "echo last",
    );
    await click("List");
    expect(jobButton("test").getAttribute("aria-expanded")).toBe("true");
    expect(jobButton("other").getAttribute("aria-expanded")).toBe("true");
    expect(commands(0)).toEqual(["echo last"]);
    expect(commands(1)).toEqual(["echo other"]);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("keeps a reviewed workflow pinned when its repository changes, then explicitly accepts the update", async () => {
    h.get.mockResolvedValue({ ...(await h.get()), source });
    const incoming = source.replace("echo tested", "echo new-repository-code");
    h.source.mockResolvedValue({ source: incoming, sha: "latest-file-sha", plan, error: null });
    await render("ci");
    await click("YAML");
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Workflow YAML"]')!.value).toBe(
      source,
    );
    expect(host.textContent).toContain("Your draft differs from the repository version.");
    await click("Review differences");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "echo new-repository-code",
    );
    expect(h.save).not.toHaveBeenCalled();
    await click("Use repository version");
    await preview();
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Workflow YAML"]')!.value).toBe(
      incoming,
    );
    expect(h.save).not.toHaveBeenCalled();
    await click("Save workflow");
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ source: incoming }), "ci");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("persists the automatic versus reviewed repository policy through the existing source contract", async () => {
    await render("ci");
    await click("Review first");
    await click("Save workflow");
    expect(h.save).toHaveBeenLastCalledWith(expect.objectContaining({ source }), "ci");
    await click("Automatic");
    await click("Save workflow");
    expect(h.save).toHaveBeenLastCalledWith(expect.objectContaining({ source: null }), "ci");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("creates a standalone workflow without any GitHub request", async () => {
    await render();
    await click("Standalone");
    await fill("Name", "Nightly cleanup");
    await preview();
    await click("Continue");
    await selectRunner();
    await click("Continue");
    await click("Continue");
    await click("Save workflow");
    expect(h.discover).not.toHaveBeenCalled();
    expect(h.source).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Nightly cleanup",
        owner: null,
        repo: null,
        runnerIds: ["linux"],
        source: expect.stringContaining("workflow_dispatch"),
      }),
      undefined,
    );
  });
  it("keeps saved standalone YAML independent even if its old path used the repository directory", async () => {
    const standalone =
      "name: Cleanup\non: workflow_dispatch\njobs:\n  clean:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo clean\n";
    h.get.mockResolvedValue({
      ...(await h.get()),
      owner: null,
      repo: null,
      path: ".github/workflows/ci.yml",
      source: standalone,
    });
    await render("ci");
    expect(h.source).not.toHaveBeenCalled();
    expect(h.discover).not.toHaveBeenCalled();
    expect(h.preview).toHaveBeenLastCalledWith(standalone, ".openship/workflows/automation.yml");
    await click("Save workflow");
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        source: standalone,
        owner: null,
        path: ".openship/workflows/automation.yml",
      }),
      "ci",
    );
  });
});
