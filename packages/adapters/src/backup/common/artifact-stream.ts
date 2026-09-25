import type { Readable } from "node:stream";
import type { Artifact, ExecExitInfo } from "../types";

/** A closed consumer must cancel capture, even while the source is backpressured. */
export function watchArtifactConsumer(stdout: Readable, label: string) {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const onClose = () => {
    if (!stdout.readableEnded) {
      reject(
        stdout.errored ?? new Error(`${label}: backup stream closed before capture completed`),
      );
    }
  };
  stdout.on("close", onClose);
  if (stdout.destroyed) onClose();
  return { promise, dispose: () => stdout.off("close", onClose) };
}

/**
 * Producers retain ownership of their process until it has exited. A failed
 * destination returns the generator at yield, skipping ordinary code after it;
 * finally still closes the stream and waits for helper cleanup / service thaw.
 */
export async function* yieldArtifact(
  artifact: Artifact,
  awaitExit: Promise<ExecExitInfo>,
  describeFailure: (exit: ExecExitInfo) => string,
): AsyncGenerator<Artifact> {
  void awaitExit.catch(() => {});
  try {
    yield artifact;
    const exit = await awaitExit;
    if (exit.code !== 0) throw new Error(describeFailure(exit));
  } finally {
    artifact.stream.destroy();
    // Preserve the original upload/process error; completion still observes and
    // settles teardown before the source connection can be disposed.
    await awaitExit.catch(() => {});
  }
}
