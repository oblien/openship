import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DockerRuntime } from "@repo/adapters";
import { packBuildContext } from "../../../../packages/adapters/src/runtime/docker";
import { buildDockerImage } from "../../../../packages/adapters/src/runtime/docker-buildkit-session";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

describeDockerE2E("BuildKit session health (#1488)", () => {
  let runtime: DockerRuntime;
  let directory: string;
  const tag = `openship-buildkit-health:${randomUUID()}`;

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("alpine:3");
    directory = await mkdtemp(join(tmpdir(), "openship-buildkit-health-"));
  });

  afterAll(async () => {
    if (runtime) {
      try {
        await runtime.docker.getImage(tag).remove({ force: true });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      } finally {
        await runtime.dispose();
      }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(["source", "bundled"])(
    "keeps optional secret mounts usable after multiple daemon health probes (%s)",
    async (mode) => {
      let build = buildDockerImage;
      if (mode === "bundled") {
        const entry = fileURLToPath(
          new URL(
            "../../../../packages/adapters/src/runtime/docker-buildkit-session.ts",
            import.meta.url,
          ),
        );
        const bundle = join(directory, "session.mjs");
        await promisify(execFile)("bun", ["build", entry, "--target=node", `--outfile=${bundle}`]);
        build = (await import(/* @vite-ignore */ pathToFileURL(bundle).href)).buildDockerImage;
      }
      await writeFile(
        join(directory, "Dockerfile"),
        [
          "FROM alpine:3",
          "RUN sleep 16",
          "RUN --mount=type=secret,id=npmrc,target=/root/.npmrc test ! -e /root/.npmrc && echo session-alive > /proof",
        ].join("\n"),
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      const context = packBuildContext(directory, ["Dockerfile"], controller.signal);
      try {
        const stream = await build(runtime.docker, context.body, {
          version: "2",
          nocache: true,
          t: tag,
          abortSignal: context.abortSignal,
        });
        // followProgress does not reliably reject a BuildKit error event. Check
        // the events AND the produced image so an ended error stream cannot pass.
        const events = await new Promise<Array<{ error?: string }>>((resolve, reject) =>
          runtime.docker.modem.followProgress(stream, (error, result) =>
            error ? reject(error) : resolve(result),
          ),
        );
        expect(events.filter((event) => event.error)).toEqual([]);
        expect((await runtime.docker.getImage(tag).inspect()).Id).toMatch(/^sha256:/);
        const container = await runtime.docker.createContainer({
          Image: tag,
          Cmd: ["cat", "/proof"],
          NetworkDisabled: true,
        });
        try {
          await container.start();
          expect((await container.wait()).StatusCode).toBe(0);
          expect(String(await container.logs({ stdout: true }))).toContain("session-alive");
        } finally {
          await container.remove({ force: true });
        }
      } finally {
        clearTimeout(timer);
        context.detachCancellation();
      }
    },
    100_000,
  );
});
