import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isProtectedBuildKitConfig } from "../packages/core/src/build-metadata-policy";

export function assertBuildkitReleaseVersion(event: string, tag: string, version: string): void {
  if (event === "push" && tag !== `v${version}`)
    throw new Error(
      "The release tag must match apps/api/package.json before publishing its protected worker.",
    );
}

type Docker = (args: string[], env: NodeJS.ProcessEnv) => string;
const docker: Docker = (args, env) =>
  execFileSync("docker", args, {
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 ** 2,
    timeout: 180_000,
  });

/** Pull only: inspect each architecture's actual config without running an image.
 * An empty Docker config proves installations can acquire the first GHCR image
 * without inheriting this publisher's registry credentials. */
export function verifyBuildkitReleaseImage(
  image: string,
  revision: string,
  run: Docker = docker,
): void {
  if (
    !/^ghcr\.io\/[a-z0-9_.-]+\/openship-buildkit:[\w][\w.-]{0,127}$/.test(image) ||
    !/^[a-f0-9]{40}$/.test(revision)
  )
    throw new Error("Invalid protected-worker release identity.");
  const config = mkdtempSync(join(tmpdir(), "openship-buildkit-public-"));
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: config };
  delete env.DOCKER_AUTH_CONFIG;
  try {
    // setup-buildx installs the executable in the publisher's Docker config.
    // Keep only that plugin discoverable; never copy config.json or auth.
    const plugin = join(
      process.env.DOCKER_CONFIG || join(homedir(), ".docker"),
      "cli-plugins",
      "docker-buildx",
    );
    if (existsSync(plugin)) {
      const plugins = join(config, "cli-plugins");
      mkdirSync(plugins);
      symlinkSync(realpathSync(plugin), join(plugins, "docker-buildx"));
    }
    const index = JSON.parse(run(["buildx", "imagetools", "inspect", "--raw", image], env));
    for (const architecture of ["amd64", "arm64"]) {
      const manifests = index.manifests?.filter(
        (manifest: any) =>
          manifest.platform?.os === "linux" && manifest.platform?.architecture === architecture,
      );
      if (manifests?.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(manifests[0].digest))
        throw new Error(`Missing or ambiguous linux/${architecture} worker manifest.`);
      const ref = `${image.slice(0, image.lastIndexOf(":"))}@${manifests[0].digest}`;
      run(["pull", "--platform", `linux/${architecture}`, ref], env);
      const images = JSON.parse(run(["image", "inspect", ref], env));
      const built = images.length === 1 ? images[0] : undefined;
      if (
        built?.Os !== "linux" ||
        built.Architecture !== architecture ||
        !isProtectedBuildKitConfig(built.Config) ||
        built.Config?.Labels?.["org.opencontainers.image.revision"] !== revision
      )
        throw new Error(
          `The linux/${architecture} artifact is not this release's protected worker.`,
        );
    }
  } catch (cause) {
    throw new Error(
      "Protected BuildKit publication is not ready: both architectures must be anonymously pullable and match this commit's policy and entrypoint. " +
        "A first GHCR package may require Public visibility in its package settings: " +
        "https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility . " +
        "API images and bundled releases remain blocked; repair the worker publication and rerun the workflows.",
      { cause },
    );
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { version } = JSON.parse(
    readFileSync(new URL("../apps/api/package.json", import.meta.url), "utf8"),
  );
  assertBuildkitReleaseVersion(
    process.env.GITHUB_EVENT_NAME ?? "",
    process.env.GITHUB_REF_NAME ?? "",
    version,
  );
  if (!process.argv.includes("--version-only"))
    verifyBuildkitReleaseImage(
      process.env.OPENSHIP_BUILDKIT_RELEASE_IMAGE ?? "",
      process.env.GITHUB_SHA ?? "",
    );
}
