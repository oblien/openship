import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectBuildKitWorker, removeProjectBuildKitWorker } from "./docker-buildkit-worker";

const worker = projectBuildKitWorker("project-a");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// Execute the actual POSIX shell against a controlled Docker command. Checking
// mocked SSH responses alone cannot exercise set -e or reconciliation failures.
async function fixture(
  options: {
    present?: boolean;
    offline?: boolean;
    removal?: "failed" | "lost-ack";
    unexpected?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "openship-worker-stop-"));
  directories.push(directory);
  await writeFile(join(directory, "state"), options.present ? worker.containerName : "");
  await writeFile(
    join(directory, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(directory, "calls"))}, JSON.stringify(args) + "\\n");
const state = ${JSON.stringify(join(directory, "state"))};
const options = ${JSON.stringify(options)};
if (args[0] === "buildx") process.exit(1); // Missing client metadata is recoverable.
if (args[0] === "container" && args[1] === "ls") {
  if (options.offline) process.exit(1);
  const name = options.unexpected ? "customer-service" : fs.readFileSync(state, "utf8");
  if (options.unexpected || args.includes("name=^/" + name + "$")) process.stdout.write(name);
} else if (args[0] === "container" && args[1] === "rm") {
  if (options.removal === "failed") process.exit(1);
  if (args.at(-1) !== fs.readFileSync(state, "utf8")) process.exit(2);
  fs.writeFileSync(state, "");
  if (options.removal === "lost-ack") process.exit(1);
} else process.exit(2);
`,
    { mode: 0o755 },
  );
  const exec = vi.fn(
    async (script: string) =>
      (
        await promisify(execFile)("sh", ["-c", script], {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        })
      ).stdout,
  );
  return {
    exec,
    calls: async () =>
      (await readFile(join(directory, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}

it("derives a stable single-node identity without accepting command text from project IDs", () => {
  expect(worker.builderName).toMatch(/^openship-cache-[a-f0-9]{24}$/);
  expect(worker.nodeName).toBe(`${worker.builderName}0`);
  expect(worker.containerName).toBe(`buildx_buildkit_${worker.nodeName}`);
  expect(projectBuildKitWorker("project-b")).not.toEqual(worker);
  expect(projectBuildKitWorker("'; docker rm other #").builderName).toMatch(
    /^openship-cache-[a-f0-9]{24}$/,
  );
});

it.skipIf(process.platform === "win32")(
  "removes a daemon worker despite missing buildx metadata in one remote command",
  async () => {
    const h = await fixture({ present: true });
    await removeProjectBuildKitWorker(h, "project-a");
    expect(h.exec).toHaveBeenCalledTimes(1);
    const calls = await h.calls();
    expect(calls.filter((args) => args[1] === "rm" && args[0] === "container")).toEqual([
      ["container", "rm", "--force", worker.containerName],
    ]);
    expect(calls).toContainEqual(["buildx", "rm", "--force", "--keep-state", worker.builderName]);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["container", "ls"]);
  },
);

it.skipIf(process.platform === "win32")(
  "accepts already absent workers only after successful daemon queries",
  async () => {
    const h = await fixture();
    await removeProjectBuildKitWorker(h, "project-a");
    expect(
      (await h.calls()).filter((args) => args[0] === "container").map((args) => args[1]),
    ).toEqual(["ls", "ls"]);
  },
);

it
  .skipIf(process.platform === "win32")
  .each([{ offline: true }, { present: true, removal: "failed" as const }, { unexpected: true }])(
  "does not confirm shutdown when Docker cannot prove absence: %j",
  async (options) => {
    const h = await fixture(options);
    await expect(removeProjectBuildKitWorker(h, "project-a")).rejects.toMatchObject({
      code: "CLOUD_BUILD_WORKER_EXIT_UNCONFIRMED",
    });
    if (options.unexpected)
      expect((await h.calls()).some((args) => args[0] === "container" && args[1] === "rm")).toBe(
        false,
      );
  },
);

it.skipIf(process.platform === "win32")(
  "reconciles a lost removal acknowledgement using confirmed daemon absence",
  async () => {
    const h = await fixture({ present: true, removal: "lost-ack" });
    await expect(removeProjectBuildKitWorker(h, "project-a")).resolves.toBeUndefined();
  },
);

it("rejects a truncated or disconnected command without a completion receipt", async () => {
  await expect(
    removeProjectBuildKitWorker({ exec: vi.fn(async () => "") }, "project-a"),
  ).rejects.toMatchObject({ code: "CLOUD_BUILD_WORKER_EXIT_UNCONFIRMED" });
});
