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
  onSaved: vi.fn(),
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
  },
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
  }: {
    plan: { jobs: Array<{ id: string; name: string }> };
    editor: { onSelect: (value: { kind: "node"; id: string }) => void };
  }) => (
    <div>
      Workflow topology
      {plan.jobs.map((job) => (
        <button
          key={job.id}
          aria-label={`Edit job: ${job.name}`}
          onClick={() => editor.onSelect({ kind: "node", id: job.id })}
        >
          {job.name}
        </button>
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
    (b) => b.textContent?.trim() === name,
  )!;
const click = (name: string) => act(async () => button(name).click());
const checkbox = (name: string) =>
  [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((label) => label.textContent?.startsWith(name))!
    .querySelector<HTMLButtonElement>('[role="checkbox"]')!;
async function fill(label: string, text: string) {
  const input = [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((row) => row.firstElementChild?.textContent === label)!
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
    name: "CI",
    owner: "acme",
    repo: "app",
    ref: "main",
    path: ".github/workflows/ci.yml",
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
          requiresDocker: false,
        };
      }),
    };
  });
  h.write.mockResolvedValue({ sha: "new-file-sha", commit: "commit" });
  h.save.mockImplementation(async (input, id) => ({ ...workflow, ...input, id: id ?? "created" }));
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
  async function editTrigger() {
    await render("ci");
    expect(host.textContent).toContain("Workflow topology");
    await click("Run settings");
    await act(async () => checkbox("Webhook").click());
    await fill("Event types (comma separated)", "release, publish");
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
    expect(saved).toMatchObject({ runnerIds: ["linux"], projectIds: ["project"] });
    expect(parse(saved.source).on.repository_dispatch.types).toEqual(["release", "publish"]);
    expect(parse(saved.source).jobs).toEqual(parse(source).jobs);
    expect(saved.source).toContain("# keep this comment");
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
    await act(async () => checkbox("Linux runner").click());
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
});
