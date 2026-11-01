import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedDockerImages, waitForDockerImages } from "./docker-images-ready";
import {
  assertBuildkitReleaseVersion,
  verifyBuildkitReleaseImage,
} from "./verify-buildkit-release";
import { affectsScope, type ReleaseHistoryRun } from "./release-resume";
import { BUILD_METADATA_POLICY_VERSION } from "../packages/core/src/build-metadata-policy";

function workflow(name: string): any {
  return Bun.YAML.parse(
    readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
  );
}

/** Model the default Actions prerequisite rule against the real workflow graph. */
function prerequisitesPass(jobs: Record<string, any>, id: string, failed: string): boolean {
  if (id === failed) return false;
  const needs = jobs[id]?.needs ?? [];
  return (Array.isArray(needs) ? needs : [needs]).every((parent) =>
    prerequisitesPass(jobs, parent, failed),
  );
}

it("cannot publish API manifests when protected-worker publication fails", () => {
  const jobs = workflow("docker-images").jobs;
  expect(jobs["merge-images"].strategy.matrix.image).toContain("api");
  expect(prerequisitesPass(jobs, "merge-images", "publish-buildkit")).toBe(false);
});

it("cannot publish bundled API, desktop or npm releases without an image receipt", () => {
  const jobs = workflow("release").jobs;
  expect(prerequisitesPass(jobs, "publish", "images-ready")).toBe(false);
  expect(jobs["publish-npm"].needs).toContain("images-ready");
  expect(jobs["publish-npm"].if).toContain("needs.images-ready.result == 'success'");
});

it("requires current-source image evidence on ordinary npm dispatch but preserves named historical resumes", () => {
  const job = workflow("release").jobs["publish-npm"];
  const expression = job.if.replace(/needs\.([\w-]+)\.result/g, 'needs["$1"].result');
  const allowed = new Function("github", "inputs", "needs", "always", `return ${expression}`);
  const needs = {
    gate: { result: "success" },
    publish: { result: "skipped" },
    "images-ready": { result: "failure" },
  };
  expect(
    allowed({ event_name: "workflow_dispatch" }, { npm_release_run: "" }, needs, () => true),
  ).toBe(false);
  needs["images-ready"].result = "success";
  expect(
    allowed({ event_name: "workflow_dispatch" }, { npm_release_run: "" }, needs, () => true),
  ).toBe(true);
  needs["images-ready"].result = needs.gate.result = "skipped";
  expect(
    allowed({ event_name: "workflow_dispatch" }, { npm_release_run: "123" }, needs, () => true),
  ).toBe(true);
});

it("uses one publisher for both stages and invalidates reused builds when its verification changes", () => {
  const jobs = workflow("docker-images").jobs;
  const publishers = [jobs["publish-buildkit"], jobs["merge-images"]];
  const actions = publishers.map((job) =>
    job.steps.find((step: any) => step.uses?.includes("/publish-image")),
  );
  expect(actions[0].uses).toBe(actions[1].uses);
  expect(jobs["merge-images"].strategy.matrix.image).not.toContain("buildkit");
  const action = Bun.YAML.parse(
    readFileSync(new URL("../.github/actions/publish-image/action.yml", import.meta.url), "utf8"),
  ) as any;
  const verify = action.runs.steps.find(
    (step: any) => step.run === "bun scripts/verify-buildkit-release.ts",
  );
  expect(verify).toBeDefined();
  expect(verify["continue-on-error"]).toBeUndefined();
  expect(affectsScope(".github/actions/publish-image/action.yml", "build")).toBe(true);
  expect(affectsScope("scripts/verify-buildkit-release.ts", "build")).toBe(true);
});

const repository = "oblien/openship";
const sha = "a".repeat(40);
const tag = "v1.2.3";
const run: ReleaseHistoryRun = {
  id: 123,
  head_sha: sha,
  head_branch: tag,
  event: "push",
  path: ".github/workflows/docker-images.yml",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
};
const jobs = ["buildkit", "api"].map((image) => ({
  name: `Publish ${image} (manifest)`,
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/example/job",
}));

it("accepts only the successful publication for this repository, tag, commit and protected worker", () => {
  expect(() => verifiedDockerImages(repository, tag, sha, run, jobs)).not.toThrow();
  for (const change of [
    { head_sha: "b".repeat(40) },
    { event: "workflow_dispatch" },
    { head_branch: "main" },
    { head_repository: { full_name: "someone/fork" } },
    { path: ".github/workflows/release.yml" },
    { status: "in_progress" },
    { conclusion: "failure" },
  ])
    expect(() => verifiedDockerImages(repository, tag, sha, { ...run, ...change }, jobs)).toThrow();
  for (const invalid of [
    [],
    jobs.slice(1),
    [...jobs, jobs[0]!],
    [{ ...jobs[0]!, conclusion: "skipped" }, jobs[1]!],
  ])
    expect(() => verifiedDockerImages(repository, tag, sha, run, invalid)).toThrow();
});

it("waits for the existing workflow, reads later job pages and rechecks the version tag", async () => {
  let elapsed = 0;
  let tagReads = 0;
  const reads: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    reads.push(path);
    if (path.startsWith("git/ref/tags/")) {
      tagReads++;
      return { object: { type: "commit", sha } } as T;
    }
    if (path.includes("/workflows/"))
      return {
        workflow_runs: [{ ...run, status: elapsed === 0 ? "in_progress" : "completed" }],
      } as T;
    if (path.includes("/jobs?filter=latest"))
      return {
        jobs: path.endsWith("page=1")
          ? Array.from({ length: 100 }, (_, i) => ({ ...jobs[0], name: `unrelated ${i}` }))
          : jobs,
      } as T;
    throw new Error(`Unexpected read ${path}`);
  };
  expect(
    await waitForDockerImages({
      repository,
      tag,
      sha,
      get,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    }),
  ).toBe(123);
  expect(elapsed).toBe(15_000);
  expect(tagReads).toBe(2);
  expect(reads.some((path) => path.endsWith("page=2"))).toBe(true);
  expect(
    reads.every((path) => /^(git\/ref\/tags\/|actions\/workflows\/|actions\/runs\/)/.test(path)),
  ).toBe(true);
});

it("rejects a moved tag, a failed image run and missing evidence within a bounded wait", async () => {
  for (const mode of ["moved", "failed", "missing", "untrusted"]) {
    let elapsed = 0;
    let tagReads = 0;
    const get = async <T>(path: string): Promise<T> => {
      if (path.startsWith("git/ref/tags/"))
        return {
          object: {
            type: "commit",
            sha: mode === "moved" && ++tagReads > 1 ? "b".repeat(40) : sha,
          },
        } as T;
      if (path.includes("/workflows/"))
        return {
          workflow_runs:
            mode === "missing"
              ? []
              : [
                  {
                    ...run,
                    head_repository: {
                      full_name: mode === "untrusted" ? "someone/fork" : repository,
                    },
                    conclusion: mode === "failed" ? "failure" : "success",
                  },
                ],
        } as T;
      return { jobs } as T;
    };
    await expect(
      waitForDockerImages({
        repository,
        tag,
        sha,
        get,
        timeoutMs: 30_000,
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
      }),
    ).rejects.toThrow();
    expect(elapsed).toBe(["missing", "untrusted"].includes(mode) ? 30_000 : 0);
  }
});

it("bounds paginated evidence even if every history page is full", async () => {
  let pages = 0;
  const get = async <T>(path: string): Promise<T> => {
    if (path.startsWith("git/ref/tags/")) return { object: { type: "commit", sha } } as T;
    pages++;
    return {
      workflow_runs: Array.from({ length: 100 }, () => ({ ...run, head_sha: "b".repeat(40) })),
    } as T;
  };
  await expect(waitForDockerImages({ repository, tag, sha, get })).rejects.toThrow("page limit");
  expect(pages).toBe(20);
});

it("resolves annotated tags and selects the latest matching attempt across run pages", async () => {
  const reads: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    reads.push(path);
    if (path.startsWith("git/ref/tags/"))
      return { object: { type: "tag", sha: "c".repeat(40) } } as T;
    if (path.startsWith("git/tags/")) return { object: { type: "commit", sha } } as T;
    if (path.includes("/workflows/"))
      return {
        workflow_runs: path.endsWith("page=1")
          ? Array.from({ length: 100 }, (_, i) => ({
              ...run,
              id: i + 1000,
              head_sha: "b".repeat(40),
            }))
          : [
              { ...run, id: 120, conclusion: "failure" },
              { ...run, id: 124 },
            ],
      } as T;
    if (path.startsWith("actions/runs/124/jobs?filter=latest")) return { jobs } as T;
    throw new Error(`Unexpected evidence ${path}`);
  };
  expect(await waitForDockerImages({ repository, tag, sha, get })).toBe(124);
  expect(reads.filter((path) => path.startsWith("git/tags/"))).toHaveLength(2);
  expect(reads.some((path) => path.includes("/workflows/") && path.endsWith("page=2"))).toBe(true);
});

it("binds pushed image releases to the embedded version while retaining custom manual tags", () => {
  expect(() => assertBuildkitReleaseVersion("push", tag, "1.2.3")).not.toThrow();
  expect(() => assertBuildkitReleaseVersion("push", "v1.2.4", "1.2.3")).toThrow();
  expect(() =>
    assertBuildkitReleaseVersion("workflow_dispatch", "manual-test", "1.2.3"),
  ).not.toThrow();
});

const index = {
  manifests: ["amd64", "arm64"].map((architecture, i) => ({
    digest: `sha256:${(i ? "b" : "a").repeat(64)}`,
    platform: { os: "linux", architecture },
  })),
};
function built(architecture: string) {
  return {
    Os: "linux",
    Architecture: architecture,
    Config: {
      Labels: {
        "org.openship.build-metadata-policy": BUILD_METADATA_POLICY_VERSION,
        "org.opencontainers.image.revision": sha,
      },
      Entrypoint: ["/usr/local/bin/openship-buildkitd"],
    },
  };
}

it("fails publication for private, incomplete, wrong-commit or unguarded worker artifacts", () => {
  for (const mode of [
    "private",
    "missing-arm",
    "wrong-policy",
    "wrong-entrypoint",
    "wrong-revision",
  ]) {
    let config: string | undefined;
    const docker = (args: string[], env: NodeJS.ProcessEnv) => {
      config = env.DOCKER_CONFIG;
      if (mode === "private") throw new Error("anonymous pull denied");
      if (args[0] === "buildx")
        return JSON.stringify(mode === "missing-arm" ? { manifests: [index.manifests[0]] } : index);
      if (args[0] === "pull") return "";
      const image = built(args.at(-1)!.endsWith("b".repeat(64)) ? "arm64" : "amd64");
      if (mode === "wrong-policy")
        image.Config.Labels["org.openship.build-metadata-policy"] = "old";
      if (mode === "wrong-entrypoint") image.Config.Entrypoint = ["buildkitd"];
      if (mode === "wrong-revision")
        image.Config.Labels["org.opencontainers.image.revision"] = "b".repeat(40);
      return JSON.stringify([image]);
    };
    expect(() =>
      verifyBuildkitReleaseImage("ghcr.io/oblien/openship-buildkit:1.2.3", sha, docker),
    ).toThrow("Public visibility");
    expect(existsSync(config!)).toBe(false);
  }
});

it("verifies both architectures through the Docker process with no publisher registry credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "openship-buildkit-probe-test-"));
  const initialPath = process.env.PATH;
  const initialConfig = process.env.DOCKER_CONFIG;
  try {
    const trace = join(dir, "trace.jsonl");
    const fakeDocker = join(dir, "docker");
    writeFileSync(
      fakeDocker,
      `#!${process.execPath}\n` +
        `
      import { appendFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      const args = process.argv.slice(2);
      if (existsSync(join(process.env.DOCKER_CONFIG, 'config.json'))) throw new Error('Publisher credentials leaked');
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, config: process.env.DOCKER_CONFIG }) + '\\n');
      const index = ${JSON.stringify(index)};
      if (args[0] === 'buildx') console.log(JSON.stringify(index));
      else if (args[0] === 'image') console.log(JSON.stringify([args.at(-1).endsWith('b'.repeat(64)) ? ${JSON.stringify(built("arm64"))} : ${JSON.stringify(built("amd64"))}]));
    `,
    );
    chmodSync(fakeDocker, 0o755);
    const authenticated = join(dir, "publisher");
    mkdirSync(authenticated);
    writeFileSync(join(authenticated, "config.json"), '{"auths":{"ghcr.io":{"auth":"test-only"}}}');
    process.env.PATH = `${dir}:${initialPath}`;
    process.env.DOCKER_CONFIG = authenticated;
    verifyBuildkitReleaseImage("ghcr.io/oblien/openship-buildkit:1.2.3", sha);
    const calls = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.args[0] === "pull").map((call) => call.args[2])).toEqual([
      "linux/amd64",
      "linux/arm64",
    ]);
    expect(calls.every((call) => call.config !== authenticated && !existsSync(call.config))).toBe(
      true,
    );
  } finally {
    if (initialPath === undefined) delete process.env.PATH;
    else process.env.PATH = initialPath;
    if (initialConfig === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = initialConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});

const nativeDocker = Bun.which("docker");
const nativeCliTest = nativeDocker || process.env.CI ? it : it.skip;
nativeCliTest(
  "keeps a config-installed Buildx discoverable to native Docker without copying registry auth",
  () => {
    if (!nativeDocker)
      throw new Error("CI requires the Docker CLI for plugin discovery verification.");
    const dir = mkdtempSync(join(tmpdir(), "openship-buildx-discovery-test-"));
    const initialConfig = process.env.DOCKER_CONFIG;
    try {
      const original = join(dir, "publisher");
      const plugins = join(original, "cli-plugins");
      mkdirSync(plugins, { recursive: true });
      const plugin = join(plugins, "docker-buildx");
      writeFileSync(
        plugin,
        `#!/bin/sh
if [ "$1" = "docker-cli-plugin-metadata" ]; then
  printf '%s\\n' '{"SchemaVersion":"0.1.0","Vendor":"Openship test","Version":"0.0.0","ShortDescription":"Buildx discovery fixture"}'
else
  printf '%s\\n' 'openship-buildx-discovery-fixture'
fi
`,
      );
      chmodSync(plugin, 0o755);
      const auth = '{"auths":{"ghcr.io":{"auth":"test-only"}}}';
      writeFileSync(join(original, "config.json"), auth);
      process.env.DOCKER_CONFIG = original;
      const docker = (args: string[], env: NodeJS.ProcessEnv) => {
        expect(existsSync(join(env.DOCKER_CONFIG!, "config.json"))).toBe(false);
        if (args[0] === "buildx") {
          // Version never contacts a daemon/registry, even if a system plugin
          // masks the missing config plugin. Its unique marker proves discovery.
          const version = execFileSync(nativeDocker, ["buildx", "version"], {
            env,
            encoding: "utf8",
            timeout: 10_000,
          });
          expect(version.trim()).toBe("openship-buildx-discovery-fixture");
          return JSON.stringify(index);
        }
        if (args[0] === "pull") return "";
        return JSON.stringify([built(args.at(-1)!.endsWith("b".repeat(64)) ? "arm64" : "amd64")]);
      };
      verifyBuildkitReleaseImage("ghcr.io/oblien/openship-buildkit:1.2.3", sha, docker);
      expect(readFileSync(join(original, "config.json"), "utf8")).toBe(auth);
      expect(existsSync(plugin)).toBe(true);
    } finally {
      if (initialConfig === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = initialConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
