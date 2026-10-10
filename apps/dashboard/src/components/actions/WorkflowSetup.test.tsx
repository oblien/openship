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
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
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
const checkbox = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`) ??
  [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((label) => label.textContent?.startsWith(name))!
    .querySelector<HTMLButtonElement>('[role="checkbox"]')!;
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
    await click("Use build server");
    await click("Verify and save runner");
    expect(h.saveRunner).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain("Build server");
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
    expect(host.textContent).toContain("GitHub App");
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
    if (directory === ".github/workflows")
      await act(async () => checkbox("Allow workflows in this repository").click());
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
    await act(async () => checkbox("Allow workflows in this repository").click());
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
        repositoryRunnerConsent: true,
        storageDestinationId: null,
        variables: {},
        secrets: {},
      }),
      "ci",
    );
    expect(h.onSaved).toHaveBeenCalledOnce();
  });
  it("requires explicit repository-wide runner trust before linking a new GitHub workflow", async () => {
    await repositoryWorkflow();
    await render();
    await fill("Repository", "acme/app");
    await preview();
    expect(button("GitHub Actions")).toBeUndefined();
    expect(button("Openship Actions")).toBeUndefined();
    await click("Continue");
    await selectRunner();
    expect(button("Continue").disabled).toBe(true);
    await act(async () => checkbox("Allow workflows in this repository").click());
    await click("Continue");
    await click("Save workflow");
    expect(h.importWorkflows).toHaveBeenCalledWith([
      expect.objectContaining({
        path: ".github/workflows/ci.yml",
        source: null,
        repositoryRunnerConsent: true,
      }),
    ]);
    expect(h.write).not.toHaveBeenCalled();
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
    await click("Continue");
    expect(button("Save workflow").disabled).toBe(true);
    await act(async () => checkbox("Allow workflows in this repository").click());
    await click("Save workflow");
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({ source: null, repositoryRunnerConsent: true }),
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
    expect(button("Continue").disabled).toBe(true);
  });
  it("requires renewed consent when the selected repository or runners change", async () => {
    await repositoryWorkflow();
    await render("ci");
    expect(button("Save workflow").disabled).toBe(false);
    await fill("Repository", "acme/other");
    await preview();
    await click("Continue");
    expect(button("Save workflow").disabled).toBe(true);
    await act(async () => checkbox("Allow workflows in this repository").click());
    expect(button("Save workflow").disabled).toBe(false);
    await click("Allowed runners");
    await act(async () => checkbox("Linux runner").click());
    await act(async () => checkbox("Linux runner").click());
    await click("Use selected runners");
    expect(button("Save workflow").disabled).toBe(true);
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
