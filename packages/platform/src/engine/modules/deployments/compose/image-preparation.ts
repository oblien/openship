import { type BuildLogger, type DockerRuntime, withDeploymentProgress } from "@repo/adapters";
import { AppError, mapConcurrent } from "@repo/core";
import type { Deployment } from "@repo/db";
import { deploymentImagePullPolicy } from "../image-pull-policy";
import { throwIfDeploymentCancelled } from "../deployment-cancellation";

type PreparedImage = Awaited<ReturnType<DockerRuntime["prepareDeploymentImage"]>>;
type ImageIntent = { retained: boolean; refresh: boolean };
type ImagePreparation = {
  startedAt: Date;
  promise: Promise<PreparedImage>;
};

/** One deployment's image receipts, shared by background pulls and cutover.
 * Keep retained and refreshed receipts separate even when they name the same tag. */
export class ComposeImagePreparation {
  private readonly images = new Map<string, ImagePreparation>();

  constructor(
    private readonly runtime: DockerRuntime,
    private readonly dep: Deployment,
    private readonly logger: BuildLogger,
    private readonly forcePullImages?: boolean,
    private readonly signal?: AbortSignal,
  ) {}

  private key(image: string, intent: ImageIntent): string {
    return `${intent.retained ? "retained" : intent.refresh ? "registry" : "existing"}\0${image}`;
  }

  receipt(image: string, intent: ImageIntent): Promise<PreparedImage> | undefined {
    return this.images.get(this.key(image, intent))?.promise;
  }

  prepare(image: string, intent: ImageIntent, signal = this.signal): ImagePreparation {
    const key = this.key(image, intent);
    const existing = this.images.get(key);
    if (existing) return existing;
    const entry: ImagePreparation = {
      startedAt: new Date(),
      promise: Promise.resolve().then(async () => {
        throwIfDeploymentCancelled(signal);
        this.logger.log(`Preparing image ${image} before service cutover...\n`);
        const policy = intent.refresh
          ? deploymentImagePullPolicy(this.dep, this.forcePullImages, image)
          : { force: false, refreshMutableTag: false };
        const prepared = await withDeploymentProgress(this.logger, `image ${image}`, () =>
          this.runtime.prepareDeploymentImage(image, {
            ...policy,
            requirePresent: intent.retained,
            signal,
            logger: this.logger,
          }),
        );
        throwIfDeploymentCancelled(signal);
        this.logger.log(
          `Image ${image} is ready (${Math.floor((Date.now() - entry.startedAt.getTime()) / 1000)}s).\n`,
        );
        return prepared;
      }),
    };
    this.images.set(key, entry);
    return entry;
  }

  /** Freeze possible retained tags before any refresh. Cutover still decides
   * which services need these images; this phase never starts a container. */
  async prefetch(
    registryImages: readonly string[],
    retainedImages: readonly string[],
    buildSignal: AbortSignal,
  ): Promise<void> {
    const signal = this.signal ? AbortSignal.any([this.signal, buildSignal]) : buildSignal;
    throwIfDeploymentCancelled(signal);
    for (const [images, retained] of [
      [retainedImages, true],
      [registryImages, false],
    ] as const) {
      await mapConcurrent(
        [...new Set(images)],
        4,
        async (image) => {
          try {
            await this.prepare(image, { retained, refresh: !retained }, signal).promise;
          } catch (error) {
            if (
              !retained ||
              !(error instanceof AppError) ||
              error.code !== "RETAINED_IMAGE_UNAVAILABLE"
            ) {
              throw error;
            }
            // A speculative lookup may miss an unused image. Keep the rejected
            // receipt so a required pin cannot later adopt a refreshed tag.
          }
        },
      );
    }
  }
}
