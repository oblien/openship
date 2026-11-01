import { join } from "node:path";
import { setDefaultBuildKitImage } from "@repo/adapters";

type DockerCommand = (...args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** Build the exact release artifact locally; the first release need not already
 * exist in GHCR for its own CI to exercise the production worker. */
export async function protectedBuildKitImage(key: string, docker: DockerCommand) {
  const image = `openship/buildkit-e2e:${key}`;
  const repository = join(import.meta.dirname, "../../../..");
  await docker(
    "build",
    "--label",
    `openship.e2e=${key}`,
    "-t",
    image,
    "-f",
    join(repository, "packages/adapters/Dockerfile.buildkit"),
    repository,
  );
  setDefaultBuildKitImage(image);
  return {
    image,
    dispose: async () => {
      const inspection = JSON.parse((await docker("image", "inspect", image)).stdout);
      if (inspection[0]?.Config?.Labels?.["openship.e2e"] !== key)
        throw new Error("Refusing to remove a BuildKit image outside this fixture.");
      await docker("image", "rm", "-f", image);
    },
  };
}
