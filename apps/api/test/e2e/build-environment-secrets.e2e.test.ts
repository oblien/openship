import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BuildLogger,
  DockerRuntime,
  SshExecutor,
  type BuildConfig,
  type LogEntry,
} from "@repo/adapters";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

// Synthetic values only. Exercise the real runtime, generated context, reverse
// session, image metadata and log boundary, not a second test-only build path.
// An optional disposable SSH host exercises the production protected worker too.
// OPENSHIP_E2E_BUILD_SSH is JSON { host, port, username, keyFile }; never key bytes.
const ssh = process.env.OPENSHIP_E2E_BUILD_SSH
  ? (JSON.parse(process.env.OPENSHIP_E2E_BUILD_SSH) as {
      host: string;
      port: number;
      username: string;
      keyFile: string;
    })
  : undefined;
for (const transport of ["socket", ...(ssh ? ["ssh"] : [])])
  describeDockerE2E(`Build environment confidentiality (#1663, ${transport})`, () => {
    let runtime: DockerRuntime;
    let directory: string;
    let executor: SshExecutor | undefined;
    const secretDirectories: string[] = [];
    const images: string[] = [];
    const projectId = randomUUID();
    const value =
      'example-private-\'value-$()-🔐\n{"private_key":"example-line1\\nexample-line2"}\n';

    beforeAll(async () => {
      await requireDocker();
      if (transport === "ssh" && ssh) {
        const config = {
          host: ssh.host,
          port: ssh.port,
          username: ssh.username,
          privateKey: await readFile(ssh.keyFile, "utf8"),
        };
        executor = new SshExecutor(config);
        const exec = executor.exec.bind(executor);
        executor.exec = async (command, options) => {
          const result = await exec(command, options);
          if (command.startsWith("mktemp -d /tmp/openship-build-secrets."))
            secretDirectories.push(result.trim());
          return result;
        };
        runtime = await DockerRuntime.create({ transport: "ssh", ...config, executor });
      } else runtime = await DockerRuntime.create({ transport: "socket" });
      await runtime.pullImage("alpine:3");
      directory = await mkdtemp(join(tmpdir(), "openship-env-e2e-"));
      await writeFile(join(directory, "source.txt"), "source fixture\n");
    }, 90_000);

    afterAll(async () => {
      if (runtime) {
        for (const image of images) await runtime.docker.getImage(image).remove({ force: true });
        if (executor) {
          const suffix = createHash("sha256").update(projectId).digest("hex").slice(0, 24);
          await executor.exec(`docker volume rm buildx_buildkit_openship-cache-${suffix}0_state`);
        }
        await runtime.dispose();
      }
      await executor?.dispose();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function build(secret: string, fail = false, cancel = false) {
      const entries: LogEntry[] = [];
      let cancellation: Promise<void> | undefined;
      const logger = new BuildLogger((entry) => {
        entries.push(entry);
        // Wait for command output, not a vertex name containing the marker.
        if (
          cancel &&
          !cancellation &&
          entry.message
            .split(/\r?\n/)
            .some((line) => /^(?:#\d+(?: \d+\.\d+)? )?CANCEL_SECRET_TEST\s*$/.test(line.trim()))
        )
          cancellation = runtime.cancelBuild(config.sessionId);
      });
      const config: BuildConfig = {
        sessionId: randomUUID(),
        projectId,
        repoUrl: "",
        branch: "main",
        localPath: directory,
        stack: "custom",
        buildImage: "alpine:3",
        runtimeImage: "alpine:3",
        packageManager: "",
        workspacePrepareCommand:
          'test -n "$EXAMPLE_VALUE" && printf prepared > /workspace/prepared',
        installCommand: 'test -f /workspace/prepared && test -n "$EXAMPLE_VALUE"',
        buildCommand:
          'printf "%s" "$EXAMPLE_VALUE" | sha256sum > /workspace/proof; printf "%s\\n" "$EXAMPLE_VALUE"' +
          (fail ? "; exit 23" : cancel ? "; echo CANCEL_SECRET_TEST; sleep 60" : ""),
        startCommand: "cat /workspace/proof",
        port: 3000,
        outputDirectory: "",
        productionPaths: [],
        rootDirectory: "",
        hasServer: true,
        envVars: { EXAMPLE_VALUE: secret, EMPTY_VALUE: "" },
        resources: { cpuCores: executor ? 0.5 : 0, memoryMb: executor ? 512 : 0, diskMb: 0 },
      };
      const result = await runtime.build(config, logger);
      await cancellation;
      if (result.imageRef) images.push(result.imageRef);
      for (const path of secretDirectories) expect(await executor!.exists(path)).toBe(false);
      const output = entries.map((entry) => entry.message).join("\n");
      expect(output).not.toContain(secret);
      expect(output).not.toContain("example-private-");
      expect(output).not.toContain("example-line1");
      expect(output).toContain("***");
      expect(result.errorMessage ?? "").not.toContain("example-private-");
      return result;
    }

    it("makes exact values available to every step, never image config/history, and uses changed values on redeploy", async () => {
      for (const secret of [value, value + "changed"]) {
        const result = await build(secret);
        expect(result.status, result.errorMessage).toBe("deploying");
        const image = runtime.docker.getImage(result.imageRef!);
        const metadata = JSON.stringify([await image.inspect(), await image.history()]);
        expect(metadata).not.toContain("example-private-");
        expect(metadata).not.toContain("export EXAMPLE_VALUE");
        const container = await runtime.docker.createContainer({
          Image: result.imageRef!,
          NetworkDisabled: true,
          Cmd: [
            "sh",
            "-c",
            'test ! -e /run/secrets/openship-build-env && test -z "$EXAMPLE_VALUE" && cat /workspace/proof',
          ],
        });
        try {
          await container.start();
          expect((await container.wait()).StatusCode).toBe(0);
          expect(String(await container.logs({ stdout: true }))).toContain(
            createHash("sha256").update(secret).digest("hex"),
          );
        } finally {
          await container.remove({ force: true });
        }
      }
    }, 180_000);

    it("removes temporary secret material when cancelled", async () => {
      const result = await build(value, false, true);
      expect(result.status).toBe("cancelled");
    }, 90_000);

    it("conceals output on a failed build while retaining its failure status", async () => {
      const result = await build(value, true);
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toMatch(/23|build failed/i);
    }, 90_000);
  });
