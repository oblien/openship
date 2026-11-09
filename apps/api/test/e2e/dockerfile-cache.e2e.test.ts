import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const env = { ...process.env, DOCKER_HOST: `unix://${dockerSocketPath}` };

// Build the shipped Dockerfiles against a small workspace. The install hook's
// random ID proves whether Docker reused installation; the built output proves
// that reusing dependencies never hides changed application/workspace source.
describeDockerE2E("official Dockerfile cache invalidation", () => {
  let directory: string;
  const image = `openship-dockerfile-cache:${randomUUID()}`;

  async function write(path: string, contents: string | object) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  }

  async function build(app: string, target: string) {
    return exec(
      "docker",
      [
        "buildx",
        "build",
        "--load",
        "--provenance=false",
        "--progress=plain",
        "--target",
        target,
        "-t",
        image,
        "-f",
        join(directory, `apps/${app}/Dockerfile`),
        directory,
      ],
      { env, timeout: 240_000, maxBuffer: 8 * 1024 * 1024 },
    );
  }

  async function read(path: string) {
    const { stdout } = await exec("docker", ["run", "--rm", image, "cat", path], { env });
    return stdout.trim();
  }

  beforeAll(async () => {
    await requireDocker();
    directory = await mkdtemp(join(tmpdir(), "openship-dockerfile-cache-"));
    await write("package.json", {
      name: `dockerfile-cache-fixture-${randomUUID()}`,
      private: true,
      workspaces: ["apps/*", "packages/*"],
      scripts: { postinstall: `bun -e 'await Bun.write(".install-id", crypto.randomUUID())'` },
    });
    await write("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
    await write("tsconfig.base.json", "{}");
    await write("patches/fixture.patch", "first patch input\n");
    await write("packages/shared/package.json", {
      name: "@fixture/shared",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    });
    await write("packages/shared/index.js", 'export default "first shared source";\n');
    for (const app of ["api", "dashboard", "web"]) {
      await write(`apps/${app}/package.json`, {
        name: `@fixture/${app}`,
        private: true,
        type: "module",
        dependencies: { "@fixture/shared": "workspace:*" },
        scripts: { build: "bun build.js" },
      });
      await write(`apps/${app}/revision.txt`, "first source");
      await write(
        `apps/${app}/build.js`,
        `
        import shared from "@fixture/shared";
        await Bun.write("build.json", JSON.stringify({
          installed: await Bun.file("../../.install-id").text(),
          revision: await Bun.file("revision.txt").text(), shared,
        }));
      `,
      );
      await copyFile(
        join(root, `apps/${app}/Dockerfile`),
        join(directory, `apps/${app}/Dockerfile`),
      );
    }
    await copyFile(join(root, ".dockerignore"), join(directory, ".dockerignore"));
    await write("apps/email/package.json", {
      name: "@fixture/email",
      private: true,
      scripts: { postinstall: "cd server && bun install && cd ../client && bun install" },
    });
    for (const part of ["server", "client"]) {
      await write(`apps/email/${part}/package.json`, {
        name: `email-${part}`,
        dependencies: { "is-number": "7.0.0" },
      });
      await exec("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
        cwd: join(directory, `apps/email/${part}`),
        timeout: 60_000,
      });
    }
    await exec("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: directory,
      timeout: 60_000,
    });
  });

  afterAll(async () => {
    await exec("docker", ["image", "rm", "-f", image], { env }).catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reuses the same dependency layer across the API, dashboard and website", async () => {
    const installs: string[] = [];
    for (const app of ["api", "dashboard", "web"]) {
      await build(app, "dependencies");
      installs.push(await read("/app/.install-id"));
      // The nested installs must have received their manifests and lockfiles.
      expect(await read("/app/apps/email/server/node_modules/is-number/package.json")).toContain(
        '"version": "7.0.0"',
      );
    }
    expect(new Set(installs).size).toBe(1);
  });

  it.each(["dashboard", "web"])("rebuilds changed %s source without reinstalling", async (app) => {
    await write("packages/shared/index.js", 'export default "first shared source";\n');
    await write(`apps/${app}/revision.txt`, "first source");
    await build(app, "builder");
    const original = JSON.parse(await read(`/app/apps/${app}/build.json`));
    const warm = await build(app, "builder");
    expect(JSON.parse(await read(`/app/apps/${app}/build.json`)), warm.stderr).toEqual(original);

    await write(`apps/${app}/revision.txt`, "changed source");
    await build(app, "builder");
    expect(JSON.parse(await read(`/app/apps/${app}/build.json`))).toEqual({
      ...original,
      revision: "changed source",
    });

    await write("packages/shared/index.js", 'export default "changed shared source";\n');
    await build(app, "builder");
    expect(JSON.parse(await read(`/app/apps/${app}/build.json`))).toEqual({
      ...original,
      revision: "changed source",
      shared: "changed shared source",
    });

    const { stdout: before } = await exec("docker", ["image", "inspect", "-f", "{{.Id}}", image], {
      env,
    });
    await write("apps/api/revision.txt", `unrelated source for ${app}`);
    await build(app, "builder");
    const { stdout: after } = await exec("docker", ["image", "inspect", "-f", "{{.Id}}", image], {
      env,
    });
    expect(after).toBe(before);
  });

  it("reinstalls when any dependency input changes and rejects an out-of-date lockfile", async () => {
    await build("dashboard", "dependencies");
    let previous = await read("/app/.install-id");
    for (const path of [
      "package.json",
      "apps/dashboard/package.json",
      "packages/shared/package.json",
      "bun.lock",
      "patches/fixture.patch",
      "apps/email/server/bun.lock",
      "apps/email/client/package.json",
    ]) {
      await appendFile(join(directory, path), "\n");
      await build("dashboard", "dependencies");
      const installed = await read("/app/.install-id");
      expect(installed, `${path} must invalidate the install layer`).not.toBe(previous);
      previous = installed;
    }
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    await write("package.json", { ...manifest, dependencies: { "is-number": "6.0.0" } });
    await expect(build("dashboard", "dependencies")).rejects.toThrow(/lockfile/i);
  });
});
