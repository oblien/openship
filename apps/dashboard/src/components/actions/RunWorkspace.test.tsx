// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActionJobView, ActionRunView } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { RunWorkspace, type RunWorkspaceView } from "./RunWorkspace";
import type { JobEvent } from "./job-progress";
import type { WorkflowGraph } from "./WorkflowGraph";

const h = vi.hoisted(() => ({ events: vi.fn(), scope: "local:owner:org" }));
vi.mock("@/lib/api/actions", () => ({ actionsApi: { events: h.events } }));
vi.mock("./useActions", () => ({ useActionScope: () => h.scope }));
vi.mock("./WorkflowGraph", () => ({
  WorkflowGraph: (props: ComponentProps<typeof WorkflowGraph>) => (
    <div data-testid="graph">
      <span>{props.jobDetails?.expandedJobs.join(",")}</span>
      {props.run?.jobs.map((job) => (
        <button key={job.id} onClick={() => props.jobDetails?.onSelectStep(job.jobKey, 1)}>
          Graph step: {job.name}
        </button>
      ))}
    </div>
  ),
}));

const now = "2026-10-11T12:00:00Z";
function job(id: string, name: string, overrides: Partial<ActionJobView> = {}): ActionJobView {
  return {
    id,
    name,
    jobKey: id,
    matrixIndex: 0,
    matrix: {},
    labels: ["self-hosted", "linux"],
    status: "success",
    phase: "finished",
    runnerId: "linux",
    startedAt: now,
    finishedAt: now,
    cleanedAt: now,
    error: null,
    checkRunId: null,
    checkError: null,
    logBytes: 100,
    lastEventSequence: 2,
    outputs: {},
    steps: {
      install: { name: `Install ${name}`, outcome: "success", conclusion: "success" },
      test: { name: `Test ${name}`, outcome: "success", conclusion: "success" },
    },
    ...overrides,
  };
}
function run(jobs = [job("build", "Build"), job("docs", "Docs")]): ActionRunView {
  return {
    id: "run",
    controller: "openship",
    workflowId: "ci",
    name: "CI",
    number: 1,
    attempt: 1,
    status: "success",
    owner: "acme",
    repo: "app",
    revision: "a".repeat(40),
    ref: "refs/heads/main",
    eventName: "push",
    actor: "octocat",
    untrusted: false,
    approvedAt: null,
    cancelRequestedAt: null,
    error: null,
    startedAt: now,
    finishedAt: now,
    createdAt: now,
    settledAt: now,
    jobs,
    plan: {
      name: "CI",
      triggers: ["push"],
      inputs: [],
      jobs: jobs.map((row) => ({
        id: row.jobKey,
        name: row.name,
        needs: [],
        runsOn: row.labels,
        requiresDocker: false,
      })),
    },
  };
}
function event(sequence: number, message: string, stepId?: string): JobEvent {
  return { version: 1, sequence, time: now, type: "log", message, stepId, stage: "Main" };
}
function page(events: JobEvent[], complete = true) {
  return { events, next: events.at(-1)?.sequence ?? 0, complete };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Harness({
  value,
  initialView = "list",
}: {
  value: ActionRunView;
  initialView?: RunWorkspaceView;
}) {
  const [selected, setSelected] = useState(value.jobs[0]?.id);
  const [step, setStep] = useState<string | null>(null);
  const [view, setView] = useState<RunWorkspaceView>(initialView);
  return (
    <I18nProvider>
      <RunWorkspace
        run={value}
        job={value.jobs.find((job) => job.id === selected)}
        selectedStep={step}
        view={view}
        onSelect={(job, step) => {
          setSelected(job);
          setStep(step ?? null);
        }}
        onViewChange={setView}
        approving={false}
        onApprove={() => {}}
      />
    </I18nProvider>
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  h.scope = "local:owner:org";
  h.events
    .mockReset()
    .mockImplementation(async (id: string) =>
      page([
        event(1, `${id}: dependency ready`, "install"),
        event(2, `${id}: tests passed`, "test"),
      ]),
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
async function render(value = run(), initialView?: RunWorkspaceView) {
  await act(async () => root.render(<Harness value={value} initialView={initialView} />));
}
function button(name: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name,
  );
  expect(found, `Button ${name}`).toBeDefined();
  return found!;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
function consoleText() {
  return host.querySelector('[role="region"][aria-label="Logs"]')?.textContent;
}

it("shows nested reusable jobs once and keeps the selected child logs while its parent is collapsed", async () => {
  const value = run([
    job("call", "Build pipeline", { reusable: true, steps: {} }),
    job("nested", "Build pipeline / Tests", { reusable: true, parentJobId: "call", steps: {} }),
    job("leaf", "Build pipeline / Tests / Linux", { parentJobId: "nested" }),
  ]);
  await render(value);
  expect(host.querySelectorAll('button[aria-label="Build pipeline / Tests / Linux"]')).toHaveLength(
    1,
  );
  await click("Build pipeline / Tests / Linux");
  await click("View step logs: Test Build pipeline / Tests / Linux");
  expect(consoleText()).toContain("leaf: tests passed");
  await click("Hide steps: Build pipeline");
  expect(host.querySelector('nav[aria-label="Job list"]')?.textContent).not.toContain(
    "Test Build pipeline / Tests / Linux",
  );
  expect(consoleText()).toContain("leaf: tests passed");
  await click("Show steps: Build pipeline");
  expect(
    button("View step logs: Test Build pipeline / Tests / Linux").getAttribute("aria-current"),
  ).toBe("step");
});

it("keeps independent job expansions and one selection/log stream across list and topology", async () => {
  await render();
  expect(button("Hide steps: Build").getAttribute("aria-expanded")).toBe("true");
  await click("View step logs: Test Build");
  expect(consoleText()).toBe("build: tests passed");
  await click("Docs");
  expect(button("Hide steps: Build").getAttribute("aria-expanded")).toBe("true");
  expect(button("Hide steps: Docs").getAttribute("aria-expanded")).toBe("true");
  await click("Hide steps: Build");
  await click("Topology");
  await click("Graph step: Docs");
  expect(consoleText()).toBe("docs: tests passed");
  await click("Job list");
  expect(button("Show steps: Build").getAttribute("aria-expanded")).toBe("false");
  expect(button("View step logs: Test Docs").getAttribute("aria-current")).toBe("step");
  expect(h.events).toHaveBeenCalledTimes(2);
  await click("Expand all");
  expect(button("Hide steps: Build").getAttribute("aria-expanded")).toBe("true");
  await click("Collapse all");
  expect(host.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0);
});

it("keeps the selected step and live journal while visiting Approvals", async () => {
  h.events
    .mockResolvedValueOnce(page([event(1, "first line", "test")], false))
    .mockResolvedValueOnce(page([event(2, "next line", "test")], false));
  await render(run([job("build", "Build", { status: "running", finishedAt: null })]));
  await click("View step logs: Test Build");
  await click("Approvals");
  expect(host.querySelector("#workflow-view-panel-approvals")?.textContent).toContain(
    "No pending approvals",
  );
  expect(host.querySelector("#workflow-view-panel-list")?.closest("[hidden]")).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await click("Job list");
  expect(button("View step logs: Test Build").getAttribute("aria-current")).toBe("step");
  expect(consoleText()).toBe("first line\nnext line");
  expect(h.events.mock.calls).toEqual([
    ["build", 0],
    ["build", 1],
  ]);
});

it("uses the yellow loading state for waiting and queued jobs without marking finished jobs as active", async () => {
  await render(
    run([
      job("waiting", "Waiting build", { status: "waiting", finishedAt: null }),
      job("queued", "Queued docs", { status: "queued", finishedAt: null }),
      job("done", "Done"),
    ]),
  );
  for (const label of ["Waiting build", "Queued docs"]) {
    const status = button(label).querySelector("[aria-label]");
    expect(status?.classList.contains("text-warning")).toBe(true);
    expect(status?.querySelector(".motion-safe\\:animate-spin")).not.toBeNull();
  }
  expect(button("Done").querySelector(".motion-safe\\:animate-spin")).toBeNull();
});

it("ignores a slow response after switching jobs and reuses completed logs when returning", async () => {
  const slow = deferred<ReturnType<typeof page>>();
  h.events.mockImplementationOnce(() => slow.promise);
  await render();
  expect(consoleText()).toContain("Loading logs");
  await click("Docs");
  await act(async () => slow.resolve(page([event(1, "stale build output", "test")])));
  expect(consoleText()).toContain("docs: tests passed");
  expect(consoleText()).not.toContain("stale build output");
  await click("Build");
  await click("Docs");
  expect(h.events.mock.calls.map(([id]) => id)).toEqual(["build", "docs", "build"]);
  expect(consoleText()).toContain("docs: tests passed");
});

it("keeps previous output on failure and retries from its saved cursor without duplicate lines", async () => {
  h.events
    .mockResolvedValueOnce(page([event(1, "first line", "test")], false))
    .mockRejectedValueOnce(new Error("Log connection interrupted"))
    .mockResolvedValueOnce(page([event(1, "first line", "test"), event(2, "last line", "test")]));
  await render(run([job("build", "Build", { status: "running", finishedAt: null })]));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(host.textContent).toContain("Log connection interrupted");
  expect(consoleText()).toBe("first line");
  await click("Try again");
  expect(consoleText()).toBe("first line\nlast line");
  expect(host.textContent).not.toContain("Log connection interrupted");
  expect(h.events.mock.calls).toEqual([
    ["build", 0],
    ["build", 1],
    ["build", 1],
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(h.events).toHaveBeenCalledTimes(3);
});

it("keeps GitHub's full log intact when the provider has no per-step log boundaries", async () => {
  h.events.mockResolvedValue(page([event(1, "one long li"), event(2, "ne\nsecond line\n")]));
  await render(
    run([
      job("build", "Build", { externalUrl: "https://github.com/acme/app/actions/runs/1/job/2" }),
    ]),
  );
  await click("View step logs: Test Build");
  expect(consoleText()).toBe("one long line\nsecond line\n");
  expect(host.textContent).toContain("Showing the complete job log.");
  await click("All job logs");
  expect(host.textContent).not.toContain("Showing the complete job log.");
  expect(h.events).toHaveBeenCalledTimes(1);
});

it("does not mislabel untagged setup output as an independent step's output", async () => {
  h.events.mockResolvedValue(page([event(1, "Worker preparing")], false));
  await render();
  await click("View step logs: Test Build");
  expect(consoleText()).toBe("No output recorded for this step.");
  expect(consoleText()).not.toContain("Worker preparing");
});

it("shows live GitHub's link and fetches the same job's completed log once it finishes", async () => {
  const value = run([
    job("build", "Build", {
      externalUrl: "https://github.com/acme/app/actions/runs/1/job/2",
      status: "running",
      finishedAt: null,
    }),
  ]);
  await render(value);
  expect(h.events).not.toHaveBeenCalled();
  expect(
    host.querySelector('a[href="https://github.com/acme/app/actions/runs/1/job/2"]'),
  ).not.toBeNull();
  await render({
    ...value,
    jobs: value.jobs.map((row) => ({ ...row, status: "success", finishedAt: now })),
  });
  expect(h.events).toHaveBeenCalledExactlyOnceWith("build", 0);
  expect(consoleText()).toContain("build: tests passed");
});

it("clears private logs on an account/instance switch and ignores the old response", async () => {
  const slow = deferred<ReturnType<typeof page>>();
  const next = deferred<ReturnType<typeof page>>();
  h.events
    .mockResolvedValueOnce(page([event(1, "private old account", "test")], false))
    .mockImplementationOnce(() => slow.promise)
    .mockImplementationOnce(() => next.promise);
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  h.scope = "remote:other:other-org";
  await render();
  expect(consoleText()).not.toContain("private old account");
  await act(async () => slow.resolve(page([event(2, "old in-flight output", "test")])));
  expect(consoleText()).not.toContain("old in-flight output");
  await act(async () => next.resolve(page([event(1, "new account output", "test")])));
  expect(consoleText()).toBe("new account output");
  expect(h.events.mock.calls).toEqual([
    ["build", 0],
    ["build", 1],
    ["build", 0],
  ]);
});

it("expands a single job's topology steps immediately", async () => {
  await render(run([job("build", "Build")]), "graph");
  expect(host.querySelector('[data-testid="graph"] > span')?.textContent).toBe("build");
  await click("Collapse all");
  expect(host.querySelector('[data-testid="graph"] > span')?.textContent).toBe("");
});
