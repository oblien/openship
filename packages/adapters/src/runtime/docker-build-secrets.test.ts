import { DockerRuntime } from "./docker";
import { BuildLogger } from "./build-pipeline";
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildConfig, CommandExecutor } from "../types";
import { buildEnvMount, dockerBuildSecrets, withDockerBuildSecrets } from "./docker-build-secrets";
import { generateDockerfile } from "./docker-build-plan";
import { resolveDockerBuildArgs } from "./docker-build-args";

const config = {
  sessionId: "attempt-a",
  projectId: "project-a",
  stack: "custom",
  buildImage: "alpine:3",
  runtimeImage: "alpine:3",
  packageManager: "",
  port: 3000,
  installCommand: "echo install",
  buildCommand: "echo build",
  resources: {},
  envVars: {
    EXAMPLE_VALUE: "quote'\nline\n$() `echo bad` \" and \\ slash\n",
    EMPTY: "",
    PATH: "/bad",
    "BAD-KEY": "ignored",
  },
} as unknown as BuildConfig;

describe("Docker build secret transport", () => {
  it("does not silently discard explicit native build resource limits", () => {
    const runtime = Object.create(DockerRuntime.prototype);
    expect(() =>
      runtime.selectDockerodeBuilder(
        { ...config, resources: { memoryMb: 512, cpuCores: 1 } },
        true,
        new BuildLogger(),
        true,
      ),
    ).toThrow("cannot enforce this build's CPU/memory limits");
  });
  it("preserves exact environment bytes without embedding values in recipes or build args", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-secret-test-"));
    try {
      const file = join(dir, "env");
      writeFileSync(file, [...dockerBuildSecrets(config).values()][0]!, { mode: 0o600 });
      const value = execFileSync(
        "sh",
        ["-c", '. "$1" && printf "%s" "$EXAMPLE_VALUE"', "sh", file],
        { encoding: "utf8" },
      );
      expect(value).toBe(config.envVars.EXAMPLE_VALUE);
      const recipe = generateDockerfile(config);
      expect(recipe).toContain("--mount=type=secret");
      expect(recipe).not.toContain(config.envVars.EXAMPLE_VALUE);
      expect(recipe).not.toContain("export EXAMPLE_VALUE");
      expect(
        resolveDockerBuildArgs(
          { ...config, buildArgs: { EXPLICIT_SECRET: "private-value" } },
          false,
        ),
      ).toEqual({ NODE_ENV: "production" });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("refreshes environment-dependent layers for a new attempt without hashing credentials", () => {
    expect(buildEnvMount(config)).toBe(
      buildEnvMount({ ...config, envVars: { EXAMPLE_VALUE: "changed" } }),
    );
    expect(buildEnvMount(config)).not.toBe(buildEnvMount({ ...config, sessionId: "attempt-b" }));
  });

  it.each(["nul", "oversized"])("rejects %s environments before transport, without quoting their contents", (kind) => {
    const value = kind === "nul" ? "private-value\0" : "private-value".repeat(50_000);
    expect(() => dockerBuildSecrets({ ...config, envVars: { EXAMPLE_VALUE: value } })).toThrow(
      kind === "nul" ? "NUL bytes" : "500 KiB",
    );
    try { dockerBuildSecrets({ ...config, envVars: { EXAMPLE_VALUE: value } }); }
    catch (error) { expect(String(error)).not.toContain("private-value"); }
  });

  it.each(["success", "failure", "abort", "write failure"])(
    "cleans private remote files after %s",
    async (mode) => {
      const commands: string[] = [];
      const executor = {
        exec: vi.fn(async (command: string) => {
          commands.push(command);
          return command.startsWith("mktemp") ? "/tmp/openship-build-secrets.abcdef\n" : "";
        }),
        writeFile: vi.fn(async () => {
          if (mode === "write failure") throw new Error(config.envVars.EXAMPLE_VALUE);
        }),
      } as unknown as CommandExecutor;
      const run = vi.fn(async (flags: string, cleanup: string) => {
        expect(flags).toContain("--secret");
        expect(flags).not.toContain(config.envVars.EXAMPLE_VALUE);
        expect(cleanup).toContain("rm -rf --");
        if (mode !== "success") throw new Error(mode);
        return "ok";
      });
      const result = withDockerBuildSecrets(executor, dockerBuildSecrets(config), run);
      if (mode === "success") await expect(result).resolves.toBe("ok");
      else
        await expect(result).rejects.toThrow(
          mode === "write failure" ? "Could not transfer" : mode,
        );
      expect(executor.writeFile).toHaveBeenCalledWith(
        "/tmp/openship-build-secrets.abcdef/0",
        expect.any(String),
        { mode: 0o600 },
      );
      expect(commands.at(-1)).toBe("rm -rf -- '/tmp/openship-build-secrets.abcdef'");
      expect(commands.join("\n")).not.toContain(config.envVars.EXAMPLE_VALUE);
      if (mode === "write failure") expect(run).not.toHaveBeenCalled();
    },
  );
});
