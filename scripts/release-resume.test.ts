import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  affectsScope,
  assertResumeBinding,
  findReusableJob,
  jobSignature,
  resumeRuns,
  RESUME_GUARD,
  successfulJob,
  trustedResumeRun,
  unpublishedReleaseRuns,
  type ResumeRun,
} from "./release-resume";
import { buildWizardArgs } from "./release-args";

const workflow = `name: Scaling E2E
jobs:
  scaling:
    name: Scaling journey (\${{ matrix.journey }})
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - name: Run the real scaling journey
        env:
          RUN_DOCKER_E2E: "1"
        run: bun run --cwd apps/api test:e2e
`;
const resumedWorkflow = workflow.replace(
  "      - name: Run the real scaling journey\n",
  `      - id: resume
        uses: ./.github/actions/release-resume
        with:
          scope: \${{ matrix.journey }}
          job-name: Scaling journey (\${{ matrix.journey }})
          workflow: .github/workflows/scaling-e2e.yml
          job-id: scaling
      - name: Run the real scaling journey
        if: ${RESUME_GUARD}
`,
);
const repository = "oblien/openship";
const run: ResumeRun = {
  id: 123,
  head_sha: "a".repeat(40),
  head_branch: "v0.8.0",
  event: "push",
  path: ".github/workflows/release.yml",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};
const job = {
  name: "Release gate / Scaling E2E / Scaling journey (application)",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/oblien/openship/actions/runs/123/job/456",
};

describe("release continuation", () => {
  it("binds both Actions checks to their own execution scope", () => {
    const source = readFileSync(new URL("../.github/workflows/actions-e2e.yml", import.meta.url), "utf8");
    for (const target of ["linux", "macos"]) {
      expect(() => assertResumeBinding(source, ".github/workflows/actions-e2e.yml", target)).not.toThrow();
      expect(() => assertResumeBinding(source.replace(`scope: actions-${target}`, "scope: unit"), ".github/workflows/actions-e2e.yml", target)).toThrow();
      expect(affectsScope("packages/actions-runner/worker.go", `actions-${target}`)).toBe(true);
      expect(affectsScope("apps/api/test/e2e/rollback-full-cycle.e2e.test.ts", `actions-${target}`)).toBe(false);
    }
    expect(affectsScope("apps/api/test/e2e/actions-runner.e2e.test.ts", "actions-linux")).toBe(true);
    expect(affectsScope("apps/api/test/helpers/workspace-runtime.ts", "actions-linux")).toBe(true);
    expect(affectsScope("apps/api/test/e2e/actions-runner.e2e.test.ts", "fast")).toBe(false);
  });
  it("has an explicit wizard command without requesting a version bump or force", () => {
    expect(buildWizardArgs({ mode: "continue", dryRun: false, forceBranch: false })).toEqual([
      "continue",
    ]);
    expect(buildWizardArgs({ mode: "continue", dryRun: true, forceBranch: false })).toEqual([
      "continue",
      "--dry-run",
    ]);
  });

  it("does not allow arbitrary skip lists or ambiguous resume records", () => {
    expect(resumeRuns("v0.8.0")).toEqual([]);
    expect(resumeRuns("v0.8.0\n\nOpenShip-Resume-Runs: 123,456,123\n")).toEqual(["123", "456"]);
    expect(() => resumeRuns("OpenShip-Resume-Runs: success,skip-storage")).toThrow();
    expect(() => resumeRuns("OpenShip-Resume-Runs: 123\nOpenShip-Resume-Runs: 456")).toThrow();
  });

  it("accepts only this repository's tag workflows", () => {
    expect(trustedResumeRun(run, repository, "v0.8.0")).toBe(true);
    expect(trustedResumeRun({ ...run, event: "pull_request" }, repository, "v0.8.0")).toBe(false);
    expect(
      trustedResumeRun(
        { ...run, head_repository: { full_name: "someone/fork" } },
        repository,
        "v0.8.0",
      ),
    ).toBe(false);
    expect(
      trustedResumeRun({ ...run, path: ".github/workflows/ci.yml" }, repository, "v0.8.0"),
    ).toBe(false);
    expect(trustedResumeRun(run, repository, "v0.8.1")).toBe(false);
  });

  it("requires a single completed successful job, including the matrix value", () => {
    expect(successfulJob([job], "Scaling journey (application)")).toEqual(job);
    for (const conclusion of ["failure", "skipped", "cancelled", null])
      expect(
        successfulJob([{ ...job, conclusion }], "Scaling journey (application)"),
      ).toBeUndefined();
    expect(
      successfulJob([{ ...job, status: "in_progress" }], "Scaling journey (application)"),
    ).toBeUndefined();
    expect(successfulJob([job], "Scaling journey (storage)")).toBeUndefined();
    expect(successfulJob([job, job], "Scaling journey (application)")).toBeUndefined();
  });

  it("checks older runs and all publishing attempts before moving an unpublished tag", async () => {
    const initialFetch = globalThis.fetch;
    const initialToken = process.env.GITHUB_TOKEN;
    let olderStatus = "completed";
    let publishConclusion = "skipped";
    let publishingSteps: [] | undefined;
    const paths: string[] = [];
    process.env.GITHUB_TOKEN = "test-only";
    globalThis.fetch = (async (url) => {
      const path = String(url);
      paths.push(path);
      if (path.includes("/workflows/"))
        return Response.json({
          workflow_runs: path.includes("/release.yml/")
            ? [
                { ...run, id: 124, status: "completed", conclusion: "failure" },
                { ...run, id: 123, status: olderStatus, conclusion: "failure" },
              ]
            : [],
        });
      return Response.json({
        jobs: [
          {
            ...job,
            name: "Publish GitHub release",
            conclusion: path.includes("/runs/123/") ? publishConclusion : "skipped",
            steps: publishingSteps,
          },
        ],
      });
    }) as typeof fetch;
    try {
      expect((await unpublishedReleaseRuns(repository, "v0.8.0")).map((item) => item.id)).toEqual([
        124, 123,
      ]);
      expect(
        paths
          .filter((path) => path.includes("/jobs?"))
          .every((path) => path.includes("filter=all")),
      ).toBe(true);
      for (publishConclusion of ["success", "failure", "cancelled"])
        await expect(unpublishedReleaseRuns(repository, "v0.8.0")).rejects.toThrow(
          "publishing attempt",
        );
      publishingSteps = [];
      await expect(unpublishedReleaseRuns(repository, "v0.8.0")).resolves.toHaveLength(2);
      publishConclusion = "skipped";
      olderStatus = "in_progress";
      await expect(unpublishedReleaseRuns(repository, "v0.8.0")).rejects.toThrow("still running");
    } finally {
      globalThis.fetch = initialFetch;
      if (initialToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = initialToken;
    }
  });

  it("keeps production, dependency and unknown helper changes in every scope", () => {
    for (const scope of [
      "application",
      "databases",
      "storage",
      "unit",
      "sdk",
      "fast",
      "heavy",
      "build",
    ])
      for (const file of [
        "packages/adapters/src/cluster/job.ts",
        "bun.lock",
        "apps/api/test/helpers/new-helper.ts",
      ])
        expect(affectsScope(file, scope)).toBe(
          scope === "sdk" ? !file.startsWith("apps/api/test/") : true,
        );
    expect(affectsScope("apps/api/test/helpers/cluster-host-lab.ts", "storage")).toBe(true);
    expect(affectsScope("apps/api/test/helpers/cluster-host-lab.ts", "application")).toBe(false);
    expect(affectsScope("apps/api/test/e2e/scaling-databases.e2e.test.ts", "databases")).toBe(true);
    expect(affectsScope("apps/api/test/e2e/scaling-databases.e2e.test.ts", "application")).toBe(
      false,
    );
  });

  it("ignores the resume wrapper but detects altered commands, conditions, runners and environment", () => {
    expect(jobSignature(resumedWorkflow, "scaling")).toBe(jobSignature(workflow, "scaling"));
    for (const changed of [
      resumedWorkflow.replace("test:e2e", "test:e2e --passWithNoTests"),
      resumedWorkflow.replace('RUN_DOCKER_E2E: "1"', 'RUN_DOCKER_E2E: "0"'),
      resumedWorkflow.replace("ubuntu-latest", "ubuntu-24.04-arm"),
      resumedWorkflow.replace("timeout-minutes: 30", "timeout-minutes: 5"),
      resumedWorkflow.replace(RESUME_GUARD, "false"),
      resumedWorkflow.replace("actions/checkout@v7", "actions/checkout@v6"),
    ])
      expect(jobSignature(changed, "scaling")).not.toBe(jobSignature(workflow, "scaling"));
  });

  it("refuses reuse inputs copied from another check or artifact", () => {
    expect(() =>
      assertResumeBinding(resumedWorkflow, ".github/workflows/scaling-e2e.yml", "scaling"),
    ).not.toThrow();
    for (const changed of [
      resumedWorkflow.replace("scope: ${{ matrix.journey }}", "scope: build"),
      resumedWorkflow.replace("job-id: scaling", "job-id: test"),
      resumedWorkflow.replace(
        "job-name: Scaling journey (${{ matrix.journey }})",
        "job-name: Scaling journey (application)",
      ),
      resumedWorkflow.replace(
        "job-id: scaling",
        "job-id: scaling\n          artifact: unrelated-installer",
      ),
    ])
      expect(() =>
        assertResumeBinding(changed, ".github/workflows/scaling-e2e.yml", "scaling"),
      ).toThrow();
  });

  it("reuses a real ancestor only for unchanged inputs and available artifacts", async () => {
    const initialDirectory = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), "openship-release-resume-"));
    const initialFetch = globalThis.fetch;
    const initialToken = process.env.GITHUB_TOKEN;
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    const write = (path: string, value: string) => {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), value);
    };
    const commit = () => {
      git("add", ".");
      git(
        "-c",
        "user.name=Release test",
        "-c",
        "user.email=release@example.invalid",
        "commit",
        "-m",
        "test",
      );
    };
    try {
      git("init", "-q");
      write(".github/workflows/scaling-e2e.yml", workflow);
      write("packages/adapters/src/cluster/job.ts", "original production code");
      commit();
      const previous = { ...run, head_sha: git("rev-parse", "HEAD") };
      write(".github/workflows/scaling-e2e.yml", resumedWorkflow);
      write("apps/api/test/e2e/scaling-databases.e2e.test.ts", "the corrected database test");
      commit();
      process.chdir(directory);
      process.env.GITHUB_TOKEN = "test-only";
      let expired = false;
      let successful = true;
      globalThis.fetch = (async (url) => {
        const path = String(url);
        return Response.json(
          path.includes("/jobs?")
            ? { jobs: [{ ...job, conclusion: successful ? "success" : "failure" }] }
            : path.includes("/artifacts?")
              ? { artifacts: [{ id: 789, name: "result", expired }] }
              : previous,
        );
      }) as typeof fetch;
      const options = {
        repository,
        tag: "v0.8.0",
        runIds: ["123"],
        scope: "application",
        jobName: "Scaling journey (application)",
        workflow: ".github/workflows/scaling-e2e.yml",
        jobId: "scaling",
        artifact: "result",
      };
      expect(await findReusableJob(options)).toEqual({
        runId: "123",
        url: job.html_url,
        artifactId: 789,
      });
      expired = true;
      expect(await findReusableJob(options)).toBeUndefined();
      expired = false;
      successful = false;
      expect(await findReusableJob(options)).toBeUndefined();
      successful = true;
      write("packages/adapters/src/cluster/job.ts", "changed production code");
      expect(await findReusableJob(options)).toBeUndefined();
      commit();
      expect(await findReusableJob(options)).toBeUndefined();
    } finally {
      process.chdir(initialDirectory);
      globalThis.fetch = initialFetch;
      if (initialToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = initialToken;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
