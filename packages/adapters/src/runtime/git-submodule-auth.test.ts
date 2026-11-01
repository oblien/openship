import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildConfig, CommandExecutor } from "../types";
import { BuildLogger, runBuildPipeline } from "./build-pipeline";
import { prepareSourceTree } from "./docker-build-context";
import { DockerRuntime } from "./docker";
import { assembleGitClone, gitShellCommand, sq, type GitCloneInvocation } from "./git-clone";

const exec = promisify(execFile);
const TOKEN = "ghs_fixtureInstallationTokenNotReal0000001";
const basic = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
let directory: string;
let server: Server;
let origin: string;
let sharedSha: string;
const requests: Array<{ path: string; authorization?: string }> = [];
const children = new Set<ReturnType<typeof spawn>>();

const isolatedEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  // Only the isolated loopback fixture uses a short-lived self-signed certificate.
  GIT_SSL_NO_VERIFY: "true",
  // A missed SSH rewrite must fail, never try a real SSH server or a local key.
  GIT_SSH_COMMAND: "false",
});

async function git(cwd: string, ...args: string[]) {
  const result = await exec(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: isolatedEnv(),
      timeout: 15_000,
    },
  );
  return result.stdout.trim();
}

async function repository(name: string, submodules: Record<string, string> = {}) {
  const source = join(directory, `source-${name}`);
  await mkdir(source);
  await git(source, "init", "-qb", "main");
  await writeFile(join(source, "content"), `${name}\n`);
  if (Object.keys(submodules).length) {
    await writeFile(
      join(source, ".gitmodules"),
      Object.entries(submodules)
        .map(([path, url]) => `[submodule "${path}"]\n path = ${path}\n url = ${url}\n`)
        .join(""),
    );
    for (const path of Object.keys(submodules))
      await git(source, "update-index", "--add", "--cacheinfo", `160000,${sharedSha},${path}`);
  }
  await git(source, "add", "content", ...(Object.keys(submodules).length ? [".gitmodules"] : []));
  await git(source, "commit", "-qm", "fixture");
  const sha = await git(source, "rev-parse", "HEAD");
  await git(directory, "clone", "--bare", source, join(directory, "acme", `${name}.git`));
  return sha;
}

function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url!, "https://fixture.test");
  requests.push({ path: url.pathname, authorization: request.headers.authorization });
  // GitHub repository paths are case-insensitive; fixtures have lowercase paths.
  const path = url.pathname.replace(
    /^\/([^/]+)\/([^/]+)/,
    (_, owner: string, repo: string) => `/${owner.toLowerCase()}/${repo.toLowerCase()}`,
  );
  if (path.startsWith("/acme/redirect.git/")) {
    response.writeHead(302, {
      Location: `${origin}/other/secret.git${url.pathname.slice("/acme/redirect.git".length)}${url.search}`,
    });
    response.end();
    return;
  }
  if (request.headers.authorization !== basic) {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
    response.end();
    return;
  }
  const child = spawn("git", ["http-backend"], {
    env: {
      ...isolatedEnv(),
      GIT_PROJECT_ROOT: directory,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: path,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method!,
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      REMOTE_USER: "fixture",
      HTTP_GIT_PROTOCOL: (request.headers["git-protocol"] as string) ?? "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let headers = Buffer.alloc(0);
  let started = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (started) {
      response.write(chunk);
      return;
    }
    headers = Buffer.concat([headers, chunk]);
    const split = headers.indexOf("\r\n\r\n");
    if (split < 0) return;
    const output: Record<string, string> = {};
    let status = 200;
    for (const line of headers.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else output[key] = value;
    }
    response.writeHead(status, output);
    response.write(headers.subarray(split + 4));
    headers = Buffer.alloc(0);
    started = true;
  });
  child.stderr.resume();
  child.once("error", () => {
    if (!started) response.writeHead(500);
    response.end();
  });
  child.once("close", () => {
    children.delete(child);
    if (!started) response.writeHead(500);
    response.end();
  });
  request.pipe(child.stdin);
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(isolatedEnv()))
    if (key.startsWith("GIT_") && value !== undefined) vi.stubEnv(key, value);
  directory = await mkdtemp(join(tmpdir(), "openship-submodule-auth-"));
  await mkdir(join(directory, "acme"));
  await exec(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=fixture.test",
    ],
    { timeout: 10_000 },
  );
  server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    handle,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  sharedSha = await repository("shared");
  await repository("parent", {
    "lib/relative": "../shared.git",
    "lib/absolute": `${origin}/aCME/sHARED.git`,
    "lib/scp": "git@127.0.0.1:Acme/Shared.git",
    "lib/ssh-url": "ssh://git@127.0.0.1/Acme/Shared.git",
  });
  await repository("unauthorized", { "lib/denied": `${origin}/Acme/denied.git` });
  await repository("foreign", { "lib/foreign": `${origin}/Other/secret.git` });
  await repository("redirect", { "lib/redirect": `${origin}/Acme/redirect.git` });
  await repository("ssh-transport", { "lib/ssh": "ssh://git@untrusted.example/Other/secret.git" });
  await repository("file-transport", { "lib/file": `file://${directory}/acme/shared.git` });
}, 30_000);

afterAll(async () => {
  for (const child of children) child.kill();
  await new Promise<void>((resolve) => {
    if (server) {
      server.close(() => resolve());
      server.closeAllConnections();
    } else resolve();
  });
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function run(
  inv: GitCloneInvocation,
  cwd: string,
  args: string[],
  shell: boolean,
  overrides: NodeJS.ProcessEnv = {},
) {
  const env = { ...isolatedEnv(), ...overrides, ...inv.env };
  return shell
    ? exec("sh", ["-c", `cd ${sq(cwd)} && ${gitShellCommand(inv, args.map(sq).join(" "))}`], {
        env: { ...isolatedEnv(), ...overrides },
        timeout: 15_000,
      })
    : exec("git", [...inv.credArgs, ...args], { cwd, env, timeout: 15_000 });
}

describe.each([false, true])("expanded App clone authentication (shell=%s)", (shell) => {
  it("materializes private relative, absolute HTTPS and SSH submodules through the same scoped helper", async () => {
    const target = join(directory, `clone-${shell}`);
    const inv = assembleGitClone({
      repoUrl: `${origin}/Acme/Parent.git`,
      gitToken: TOKEN,
      gitTokenRepositories: ["Parent", "Shared"],
    });
    expect(inv.cloneUrl).not.toContain(TOKEN);
    await run(inv, directory, ["clone", "--depth", "1", inv.cloneUrl, target], shell);
    await run(
      inv,
      target,
      ["submodule", "update", "--init", "--recursive", "--checkout", "--depth", "1"],
      shell,
    );
    for (const path of ["relative", "absolute", "scp", "ssh-url"])
      expect(await readFile(join(target, "lib", path, "content"), "utf8")).toBe("shared\n");
    const saved = await readFile(join(target, ".git/config"), "utf8");
    expect(saved).not.toContain(TOKEN);
    expect(saved).not.toContain("credential.helper");
    expect(
      requests.some(
        (request) =>
          request.path.toLowerCase().startsWith("/acme/shared.git/") &&
          request.authorization === basic,
      ),
    ).toBe(true);
  });

  it.each(["unauthorized", "foreign"])(
    "does not lend the App token to %s submodules",
    async (parent) => {
      const target = join(directory, `${parent}-${shell}`);
      const inv = assembleGitClone({
        repoUrl: `${origin}/Acme/${parent}.git`,
        gitToken: TOKEN,
        gitTokenRepositories: [parent, "shared"],
      });
      await run(inv, directory, ["clone", "--depth", "1", inv.cloneUrl, target], shell);
      const start = requests.length;
      await expect(
        run(inv, target, ["submodule", "update", "--init", "--recursive"], shell),
      ).rejects.toThrow();
      const child = requests.slice(start);
      expect(child.length).toBeGreaterThan(0);
      expect(child.every((request) => request.authorization === undefined)).toBe(true);
    },
  );

  it("rejects unapproved SSH transports without consulting ambient SSH credentials", async () => {
    const target = join(directory, `ssh-transport-${shell}`);
    const marker = join(directory, `ssh-invoked-${shell}`);
    const script = join(directory, `ssh-sentinel-${shell}.sh`);
    const global = join(directory, `ssh-allowed-${shell}.config`);
    await writeFile(script, `#!/bin/sh\nprintf invoked > ${sq(marker)}\nexit 97\n`);
    await writeFile(global, '[protocol "ssh"]\n allow = always\n');
    const inv = assembleGitClone({
      repoUrl: `${origin}/Acme/ssh-transport.git`,
      gitToken: TOKEN,
      gitTokenRepositories: ["ssh-transport"],
    });
    const overrides = { GIT_SSH_COMMAND: `sh ${sq(script)}`, GIT_CONFIG_GLOBAL: global };
    await run(inv, directory, ["clone", "--depth", "1", inv.cloneUrl, target], shell, overrides);
    // Negative control: an inherited per-protocol allow overrides protocol.allow.
    // With only the env allowlist removed, Git invokes our inert SSH sentinel.
    const withoutAllowlist = {
      ...inv,
      env: Object.fromEntries(
        Object.entries(inv.env).filter(([key]) => key !== "GIT_ALLOW_PROTOCOL"),
      ),
      gitEnv: inv.gitEnv.replace(" GIT_ALLOW_PROTOCOL=https", ""),
    };
    await expect(
      run(
        withoutAllowlist,
        target,
        ["submodule", "update", "--init", "--recursive"],
        shell,
        overrides,
      ),
    ).rejects.toThrow();
    expect(await readFile(marker, "utf8")).toBe("invoked");
    await rm(marker);
    await expect(
      run(inv, target, ["submodule", "update", "--init", "--recursive"], shell, overrides),
    ).rejects.toThrow(/transport 'ssh' not allowed/);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects file submodules despite an ambient file transport allowance", async () => {
    const target = join(directory, `file-transport-${shell}`);
    const global = join(directory, `file-allowed-${shell}.config`);
    await writeFile(global, '[protocol "file"]\n allow = always\n');
    const inv = assembleGitClone({
      repoUrl: `${origin}/Acme/file-transport.git`,
      gitToken: TOKEN,
      gitTokenRepositories: ["file-transport", "shared"],
    });
    const overrides = { GIT_CONFIG_GLOBAL: global };
    await run(inv, directory, ["clone", "--depth", "1", inv.cloneUrl, target], shell, overrides);
    await expect(
      run(inv, target, ["submodule", "update", "--init", "--recursive"], shell, overrides),
    ).rejects.toThrow(/transport 'file' not allowed/);
    await expect(readFile(join(target, "lib/file/content"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not follow repository redirects carrying a grant to another path", async () => {
    const inv = assembleGitClone({
      repoUrl: `${origin}/Acme/redirect.git`,
      gitToken: TOKEN,
      gitTokenRepositories: ["redirect"],
    });
    const start = requests.length;
    await expect(run(inv, directory, ["ls-remote", inv.cloneUrl], shell)).rejects.toThrow();
    expect(
      requests.slice(start).every((request) => request.path.startsWith("/Acme/redirect.git/")),
    ).toBe(true);
  });
});

it.each(["pipeline", "server-docker", "orchestrator-docker"] as const)(
  "preserves the exact repository grant through the %s clone path",
  async (path) => {
    const config: BuildConfig = {
      sessionId: "submodule-auth",
      projectId: "fixture",
      slug: "fixture",
      repoUrl: `${origin}/Acme/Parent.git`,
      branch: "main",
      gitToken: TOKEN,
      gitTokenRepositories: ["Parent", "Shared"],
      stack: "docker",
      buildImage: "",
      runtimeImage: "",
      packageManager: "",
      installCommand: "",
      buildCommand: "",
      outputDirectory: "",
      port: 3000,
      envVars: {},
      resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    };
    let target = join(directory, `adapter-${path}`);
    let cleanup = async () => {};
    const messages: string[] = [];
    const logger = new BuildLogger((entry) => messages.push(entry.message));
    const shell = async (command: string) => {
      const result = await exec("sh", ["-c", command], { env: isolatedEnv(), timeout: 15_000 });
      return result.stdout;
    };
    try {
      if (path === "pipeline") {
        const result = await runBuildPipeline(
          {
            projectDir: target,
            exec: async (command) => {
              await shell(command);
            },
          },
          config,
          logger,
        );
        expect(result.status).toBe("deploying");
      } else if (path === "server-docker") {
        const runtime = Object.create(DockerRuntime.prototype);
        Object.assign(runtime, {
          connectionOptions: {
            executor: {
              exec: shell,
              streamExec: async (command: string) => ({ code: 0, output: await shell(command) }),
            } as unknown as CommandExecutor,
          },
        });
        await runtime.cloneSourceOnRemote(config, target, logger);
      } else {
        const tree = await prepareSourceTree(config, {
          onLog: (entry) => messages.push(entry.message),
        });
        target = tree.contextDir;
        cleanup = tree.cleanup;
      }
      for (const child of ["relative", "absolute", "scp", "ssh-url"])
        expect(await readFile(join(target, "lib", child, "content"), "utf8")).toBe("shared\n");
      expect(messages.join("\n")).not.toContain(TOKEN);
    } finally {
      await cleanup();
    }
  },
  20_000,
);
