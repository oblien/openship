import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DockerRuntime } from "@repo/adapters";
import { verifyUnknownImageServices } from "@repo/platform/engine/modules/updates/local-image-drift";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const docker = async (...args: string[]) =>
  (
    await exec("docker", args, {
      env: { ...process.env, DOCKER_HOST: `unix://${dockerSocketPath}` },
    })
  ).stdout.trim();

describeDockerE2E("image update drift after a local tag moves", () => {
  let runtime: DockerRuntime, dir: string;
  const tag = `openship-drift-e2e-${randomUUID()}`;
  const images: string[] = [],
    containers: string[] = [];
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    dir = await mkdtemp(join(tmpdir(), "openship-image-drift-"));
    await writeFile(
      join(dir, "Dockerfile"),
      'FROM busybox:1.37\nARG VERSION\nARG TEST_ID\nLABEL openship.drift-test="${TEST_ID}-${VERSION}"\nCMD ["sleep", "3600"]\n',
    );
  });
  afterAll(async () => {
    for (const id of containers) await docker("rm", "-f", id).catch(() => {});
    for (const id of images) await docker("rmi", "-f", id).catch(() => {});
    await runtime?.dispose();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it("detects the untagged running image without pulling or restarting the container", async () => {
    images.push(`${tag}:latest`, `${tag}:v2`);
    await docker(
      "build",
      "-q",
      "--build-arg",
      "VERSION=old",
      "--build-arg",
      `TEST_ID=${tag}`,
      "-t",
      `${tag}:latest`,
      dir,
    );
    const oldId = await docker("image", "inspect", "--format", "{{.Id}}", `${tag}:latest`);
    images.push(oldId);
    const containerId = await docker("run", "-d", `${tag}:latest`);
    containers.push(containerId);
    await docker(
      "build",
      "-q",
      "--build-arg",
      "VERSION=new",
      "--build-arg",
      `TEST_ID=${tag}`,
      "-t",
      `${tag}:v2`,
      dir,
    );
    await docker("tag", `${tag}:v2`, `${tag}:latest`);
    const observed = {
      serviceId: "web",
      name: "web",
      ref: `${tag}:latest`,
      deployedDigest: null,
      latestDigest: null,
      behind: false,
      unknown: true,
    };
    const started = await docker("inspect", "--format", "{{.State.StartedAt}}", containerId);
    expect(
      JSON.parse(await docker("image", "inspect", "--format", "{{json .RepoDigests}}", oldId)) ??
        [],
    ).toHaveLength(0);
    await verifyUnknownImageServices(runtime, [{ serviceId: "web", containerId }], [observed]);
    expect(observed).toMatchObject({ behind: true, unknown: false, deployedDigest: null });
    expect(await docker("inspect", "--format", "{{.Image}}", containerId)).toBe(oldId);
    expect(await docker("inspect", "--format", "{{.State.StartedAt}}", containerId)).toBe(started);
    expect((await runtime.getContainerInfo(containerId)).status).toBe("running");
  });
});
