import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  prepareNodeOutput,
  prepareNodeOutputCommand,
  imageStartCommand,
  START_SOURCE_LABEL,
  START_COMMAND_LABEL,
  startCommandDigest,
  AUTOMATIC_START,
} from "./node-output";
import { buildEnvironmentPreflight } from "./build-env-preflight";
import { BuildLogger } from "./build-pipeline";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "openship-output-"));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), content);
  }
  return dir;
}
const config = {
  stack: "nextjs",
  rootDirectory: "apps/web",
  startCommand: "next start",
  outputDirectory: ".next",
};
const files = {
  ".next/required-server-files.json": JSON.stringify({ relativeAppDir: "apps/web" }),
  ".next/standalone/apps/web/server.js": "console.log(process.cwd());",
  ".next/standalone/packages/shared/index.js": "shared dependency",
  ".next/standalone/server.js": "throw new Error('wrong app');",
  ".next/static/asset.js": "static asset",
  "public/logo.svg": "logo",
};

describe("shared application output", () => {
  test("preserves the complete traced monorepo and places both asset directories beside the selected app", async () => {
    const dir = await fixture(files);
    const plan = await prepareNodeOutput({
      kind: "nextjs",
      directory: ".next",
      entry: "server.js",
      projectDir: dir,
      rootDirectory: "wrong-root",
    });
    expect(plan).toEqual({
      bundleDir: join(dir, ".next/standalone"),
      startCommand: "node 'apps/web/server.js'",
    });
    expect(await readFile(join(plan!.bundleDir, "apps/web/.next/static/asset.js"), "utf8")).toBe(
      "static asset",
    );
    expect(await readFile(join(plan!.bundleDir, "apps/web/public/logo.svg"), "utf8")).toBe("logo");
    expect(await readFile(join(plan!.bundleDir, "packages/shared/index.js"), "utf8")).toBe(
      "shared dependency",
    );
  });
  test("generated Docker/SSH command executes independently of the platform bundle", async () => {
    const dir = await fixture(files);
    execFileSync("sh", ["-c", prepareNodeOutputCommand(config, dir)!]);
    expect(execFileSync("sh", [".openship-start.sh"], { cwd: dir, encoding: "utf8" }).trim()).toBe(
      await realpath(join(dir, ".next/standalone")),
    );
  });
  test("Nuxt uses its self-contained Nitro output, while custom commands keep their semantics", async () => {
    const dir = await fixture({ ".output/server/index.mjs": "console.log('nitro')" });
    execFileSync("sh", [
      "-c",
      prepareNodeOutputCommand(
        { stack: "nuxt", startCommand: "node .output/server/index.mjs" },
        dir,
      )!,
    ]);
    expect(execFileSync("sh", [".openship-start.sh"], { cwd: dir, encoding: "utf8" }).trim()).toBe(
      "nitro",
    );
    execFileSync("sh", [
      "-c",
      prepareNodeOutputCommand({ ...config, startCommand: "printf custom" }, dir)!,
    ]);
    expect(execFileSync("sh", [".openship-start.sh"], { cwd: dir, encoding: "utf8" })).toBe(
      "custom",
    );
    expect(prepareNodeOutputCommand({ stack: "django" }, dir)).toBeUndefined();
  });
  test("rejects manifest traversal, handles absent optional assets, and recognizes a default package script", async () => {
    const dir = await fixture({
      ".next/standalone/server.js": "",
      "package.json": '{"scripts":{"start":"next start"}}',
    });
    expect(
      await prepareNodeOutput({
        kind: "nextjs",
        directory: ".next",
        entry: "server.js",
        projectDir: dir,
        startCommand: "bun run start",
        defaultStartCommand: "next start",
      }),
    ).not.toBeNull();
    await writeFile(
      join(dir, ".next/required-server-files.json"),
      '{"relativeAppDir":"../../outside"}',
    );
    await expect(
      prepareNodeOutput({
        kind: "nextjs",
        directory: ".next",
        entry: "server.js",
        projectDir: dir,
      }),
    ).rejects.toThrow("escapes");
  });
  test("an explicit runtime command change takes precedence over an image's automatic launcher", () => {
    const labels = {
      [START_SOURCE_LABEL]: startCommandDigest("next start"),
      [START_COMMAND_LABEL]: AUTOMATIC_START,
    };
    expect(imageStartCommand(labels, "next start")).toBe(AUTOMATIC_START);
    expect(
      imageStartCommand(
        { ...labels, [START_COMMAND_LABEL]: "sh .openship-start.sh" },
        "next start",
      ),
    ).toBe(AUTOMATIC_START);
    expect(imageStartCommand(labels, "node custom.js")).toBe("node custom.js");
    expect(imageStartCommand(undefined, "next start")).toBe("next start");
  });
});

test("cross-stack environment preflight prints missing names without sourcing example values", async () => {
  const dir = await fixture({
    ".env.example": 'MISSING=\nSUPPLIED=\nOPTIONAL=default\nQUOTED=""\nEVIL=$(touch executed)\n',
  });
  const output = execFileSync("sh", ["-c", buildEnvironmentPreflight({ SUPPLIED: "secret" })], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(output).toContain("MISSING");
  expect(output).toContain("QUOTED");
  expect(output).not.toMatch(/SUPPLIED|secret|OPTIONAL|EVIL|executed/);
  await expect(readFile(join(dir, "executed"))).rejects.toThrow();
});

test("cache summaries count completed work only, including fragmented/interleaved BuildKit output", () => {
  const log = new BuildLogger();
  log.observeBuildOutput("#1 [builder 1/3] RUN install\n#1 CAC");
  log.observeBuildOutput(
    "HED\n#2 [builder 2/3] COPY . .\n#2 DONE 1s\n#3 [builder 3/3] RUN build\n",
  );
  log.observeBuildOutput("#1 [builder 1/1] RUN install\n#1 CACHED\n", "other");
  expect(log.cacheSummary()).toBe("Docker layer cache: 2 hit(s), 1 miss(es).");
});
