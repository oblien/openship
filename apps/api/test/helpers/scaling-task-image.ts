import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScalingLab } from "./scaling-lab";

const run = promisify(execFile);
/** Build the exact shipped task image and load it into every disposable node.
 * This avoids needing a previously published release to test a new release. */
export async function scalingTaskImage(lab: ScalingLab) {
  const image = `openship-e2e:${lab.id}-database-tasks`;
  const directory = await mkdtemp(join(tmpdir(), "openship-task-image-"));
  const archive = join(directory, "tasks.tar");
  const dispose = async () => {
    try {
      const current = await lab.docker.getImage(image).inspect();
      if (current.Config.Labels?.["openship.e2e"] !== lab.id)
        throw new Error("Refusing to remove an image outside this scaling fixture.");
      await lab.docker.getImage(image).remove({ force: true, noprune: true });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
  };
  try {
    console.info("[database-e2e] Building the production backup/recovery task image.");
    const building = run(
      "docker",
      [
        "build",
        "--label",
        `openship.e2e=${lab.id}`,
        "-t",
        image,
        "-f",
        "packages/adapters/Dockerfile.cluster-tasks",
        ".",
      ],
      {
        cwd: join(import.meta.dirname, "../../../.."),
        maxBuffer: 16 * 1024 * 1024,
        timeout: 1200000,
      },
    );
    for (const stream of [building.child.stdout, building.child.stderr])
      stream?.on("data", (chunk: Buffer) => {
        const message = chunk.toString().trim();
        if (message) console.info(`[database-e2e:build] ${message}`);
      });
    await building;
    await run("docker", ["save", "--output", archive, image], { timeout: 180000 });
    for (const [index, node] of lab.nodes.entries()) {
      await run("docker", ["cp", archive, `${node.container.id}:/tmp/openship-tasks.tar`], {
        timeout: 180000,
      });
      // The K3s image dispatches tools by executable name. Invoke ctr directly
      // and import into the kubelet's containerd namespace.
      await lab.nodeExec(
        index,
        [
          "ctr",
          "--address",
          "/run/k3s/containerd/containerd.sock",
          "--namespace",
          "k8s.io",
          "images",
          "import",
          "/tmp/openship-tasks.tar",
        ],
        180,
      );
      await lab.nodeExec(index, ["rm", "/tmp/openship-tasks.tar"]);
      console.info(`[database-e2e] Recovery image loaded on ${node.name}.`);
    }
    return { image, dispose };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
