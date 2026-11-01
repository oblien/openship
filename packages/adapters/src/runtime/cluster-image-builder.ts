import { createHash } from "node:crypto";
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { BuildConfig, BuildResult, ImageArtifactConfig } from "../types";
import type { BuildLogger } from "./build-pipeline";
import { ownsBuiltImage, type DockerRuntime } from "./docker";

export const clusterBuildImageTag = (repository: string, buildId: string) =>
  `${repository}:release-${createHash("sha256").update(buildId).digest("hex").slice(0, 24)}`;

/** Both cluster schedulers build once and distribute a verified immutable registry image. */
export class ClusterImageBuilder {
  private builder?: Promise<DockerRuntime>;
  readonly artifacts = new Map<string, string>();
  constructor(
    private readonly options: {
      imageRepository?: string;
      builder: () => Promise<DockerRuntime>;
      signal: () => AbortSignal;
    },
  ) {}
  buildRuntime() {
    return (this.builder ??= this.options.builder());
  }
  async rememberArchitecture(imageRef: string, builder: DockerRuntime) {
    const image = await builder.docker.getImage(imageRef).inspect();
    if (!["amd64", "arm64"].includes(image.Architecture) || image.Os !== "linux")
      throw new Error("Cluster applications require a Linux amd64 or arm64 image.");
    this.artifacts.set(imageRef, image.Architecture);
  }
  async build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult> {
    if (!this.options.imageRepository)
      throw new Error("Choose a registry repository for cluster source builds.");
    const builder = await this.buildRuntime();
    const result = await builder.build(config, logger);
    if (!result.imageRef || result.status === "failed" || result.status === "cancelled")
      return result;
    logger?.log(
      "Publishing this release so every eligible cluster server can pull the same image.\n",
    );
    await this.rememberArchitecture(result.imageRef, builder);
    const publishedTag = clusterBuildImageTag(this.options.imageRepository, config.sessionId);
    try {
      const imageRef = await builder.publishImage(
        result.imageRef,
        publishedTag,
        this.options.signal(),
      );
      this.artifacts.set(imageRef, this.artifacts.get(result.imageRef)!);
      return { ...result, imageRef, artifactOwned: false };
    } finally {
      // Cluster nodes pull from the registry; the builder's generated aliases
      // are disposable cache, not the retained release artifact.
      for (const image of [
        publishedTag,
        ...(ownsBuiltImage(result.imageRef) ? [result.imageRef] : []),
      ]) {
        await builder.removeImage(image).catch((error) => {
          observeCaughtError(error, "adapters/runtime/cluster-image-builder");
          return logger?.log(
            `Local build image cleanup deferred: ${error instanceof Error ? error.message : String(error)}\n`,
            "warn",
          );
        });
      }
    }
  }
  async prepareImage(config: ImageArtifactConfig, logger?: BuildLogger): Promise<BuildResult> {
    const builder = await this.buildRuntime();
    const result = await builder.prepareImage(config, logger);
    if (result.status === "failed" || result.status === "cancelled") return result;
    if (result.imageRef) {
      if (!/@sha256:[a-f0-9]{64}$/.test(result.imageRef))
        throw new Error(
          "The registry did not provide an immutable image digest. Retry after checking the image repository.",
        );
      await this.rememberArchitecture(result.imageRef, builder);
    }
    return result;
  }
  async cancelBuild(id: string) {
    if (this.builder) await (await this.builder).cancelBuild(id);
  }
  async getBuildLogs(id: string) {
    return this.builder ? (await this.builder).getBuildLogs(id) : [];
  }
  async dispose() {
    if (this.builder) await (await this.builder).dispose();
  }
}
