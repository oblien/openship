/**
 * Shared mechanics for OUR managed host-networked containers (the edge, the mail
 * engine): inspect a container's state/image, build an image from a checkout, and
 * swap a running container onto a new image with rollback.
 *
 * This is the neutral LEAF both `ensure-container-edge` and `ensure-container-mail`
 * delegate to — it depends only on the executor, `sq` and `node:path`, so either
 * installer can import it without the two importing each other. Each installer keeps
 * only what is genuinely its own (the edge's 80/443 consent takeover; mail's pg
 * sidecar, secret env-files and first-boot provisioning).
 *
 * Staleness is a plain tag-compare at the call sites: the pinned dev tag is
 * content-derived (`…-dev.<hash>`), so a source edit moves it exactly like a prod
 * version bump — no image-ID probe is needed, and `swapManagedImage` runs onto the
 * image `deliverManagedImage` already placed on the box.
 *
 * The ordering rule every path here obeys, inherited from the edge's bare→container
 * conversion: obtain the replacement image and start it BEFORE the old one is torn
 * down, and roll back to the old image if the new one doesn't come up — a failed
 * update must never leave the box without the thing it was serving.
 */

import { posix } from "node:path";

import type { CommandExecutor, LogEntry } from "../types";
import { sq } from "./local-shell";
import type { SystemLog, SystemLogCallback } from "./types";

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

/** "mail engine" → "Mail engine" for the head of a sentence. */
function titleCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export type ManagedImageKind = "edge" | "mail";

// Whether THIS control plane builds a given managed image from a source checkout (dev)
// rather than pulling a published tag (prod). Injected at boot PER COMPONENT from the
// presence of ITS OWN build spec — the SAME signal that switches that component's
// `pinned*Image()` onto the content-derived `…-dev.<hash>` tag. Per-component, not
// global: a box may build one component from source (an unpublished tag) while pulling
// another's published tag, so a single OR-ed flag would divert a pullable image into
// the from-source backstop. When set, a managed image ABSENT from the box means the
// control-plane build/ship didn't complete: the tag is unpublished, so a `docker pull`
// can only 404. The create/swap paths surface that plainly instead of a doomed pull.
// Default false ⇒ prod pulls exactly as before.
const fromSourceManaged: Record<ManagedImageKind, boolean> = { edge: false, mail: false };
export function setManagedImagesFromSource(kind: ManagedImageKind, value: boolean): void {
  fromSourceManaged[kind] = value;
}
export function managedImagesAreFromSource(kind: ManagedImageKind): boolean {
  return fromSourceManaged[kind];
}

/**
 * The one diagnostic for a from-source (dev) managed image that isn't on a box: its
 * tag is unpublished, so the control-plane build/ship didn't complete and a pull can
 * only 404. Shared by the edge + mail create paths so the wording can't drift.
 */
export function fromSourceImageMissingMessage(label: string, image: string): string {
  return (
    `The from-source ${label} image ${image} isn't on this server — the control-plane ` +
    "build or transfer didn't complete (see the log above). It's an unpublished dev " +
    "tag, so there's nothing to pull; fix the build and retry."
  );
}

// ─── Inspection primitives ─────────────────────────────────────────────────────

/** Is Docker usable on this box? A container edge/engine needs it; a bare one doesn't. */
export async function dockerAvailable(executor: CommandExecutor): Promise<boolean> {
  return executor
    .exec("docker version --format '{{.Server.Version}}' 2>/dev/null")
    .then((v) => Boolean(v.trim()))
    .catch(() => false);
}

/**
 * A container's existence, run state and created-with image ref, in one
 * `docker inspect`. `null` means no such container (or the daemon didn't answer).
 *
 * Run state comes from `.State.Running` and NEVER from the inspect having
 * succeeded: `docker inspect` answers happily for a STOPPED container, so
 * "inspect returned an image ref" proves existence only. Conflating the two is
 * what made a stopped mail engine report as running — and its one-click repair a
 * no-op that logged "already running".
 */
export async function containerState(
  executor: CommandExecutor,
  container: string,
): Promise<{ running: boolean; image: string | null } | null> {
  const out = await executor
    .exec(`docker inspect -f '{{.State.Running}}\t{{.Config.Image}}' ${sq(container)} 2>/dev/null`)
    .catch(() => "");
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const [running, image] = line.split("\t");
  return { running: running?.trim() === "true", image: image?.trim() || null };
}

/** The image ref a container was created from, running or not. */
export async function containerImageRef(
  executor: CommandExecutor,
  container: string,
): Promise<string | null> {
  return (await containerState(executor, container))?.image ?? null;
}

/** Is `ref` already present in the executor's local Docker image store? */
export async function imageExistsLocally(executor: CommandExecutor, ref: string): Promise<boolean> {
  const out = await executor
    .exec(`docker image inspect -f '{{.Id}}' ${sq(ref)} 2>/dev/null`)
    .catch(() => "");
  return Boolean(out.trim());
}

// ─── Build / acquire ───────────────────────────────────────────────────────────

/**
 * Build a managed image from a source checkout — the dev path that stands in for a
 * pull of an unpublished tag. `context` is the repo root (the Dockerfile's COPY paths
 * are repo-root-relative); throws on a non-zero build.
 *
 * Runs on the executor of the box that will RUN the image (`deliverManagedImage`
 * builds on the target, never cross-builds on the control plane), so the build is
 * always same-arch and needs no `--platform`/QEMU. Deliberately NOT forced onto
 * BuildKit: a plain `docker` CLI without the buildx plugin (homebrew + colima, no
 * Docker Desktop) hard-fails when BuildKit is explicitly requested but falls back to
 * the legacy builder for an unadorned `docker build` — and the legacy builder honours
 * `.dockerignore` too, so the context stays small either way. Letting the daemon pick
 * its own default builder is what makes this work on every box.
 */
export async function buildImage(
  executor: CommandExecutor,
  image: string,
  build: { dockerfile: string; context: string },
  onLog: SystemLogCallback,
  label: string,
): Promise<void> {
  const dockerfile = posix.join(build.context, build.dockerfile);
  onLog(log(`Building ${label} image ${image} from ${build.context} (dev/from-source)...`));
  const res = await executor.streamExec(
    `docker build -t ${sq(image)} -f ${sq(dockerfile)} ${sq(build.context)}`,
    onLog as (l: LogEntry) => void,
  );
  if (res.code !== 0) {
    throw new Error(
      `Could not build the ${label} image ${image} from ${build.context}. ` +
        "Check the Dockerfile and the build output above, then retry.",
    );
  }
}

// ─── Swap ────────────────────────────────────────────────────────────────────────

/**
 * Move a running managed container onto a new image (the pull path): pull unless the
 * target is already local, start it, and put the OLD image back if the new one
 * doesn't come up. Best-effort by design — a failed update must leave the box
 * serving, so it logs and reports rather than throwing.
 *
 * `start(image)` is the component's own "start this image AND prove it's serving"
 * callback (the edge verifies :80; mail verifies :25/:993), so an update that leaves
 * a crash-looping container reads as a failed swap, not a successful one.
 *
 * `down: true` means the swap failed AND the rollback failed — the box has NOTHING
 * serving. It must be reported, not just logged, or the worst outcome is invisible.
 */
export async function swapManagedImage(
  executor: CommandExecutor,
  opts: {
    kind: ManagedImageKind;
    from: string;
    to: string;
    label: string;
    onLog: SystemLogCallback;
    start: (image: string) => Promise<boolean>;
  },
): Promise<{ swapped: boolean; down: boolean }> {
  const { kind, from, to, label, onLog, start } = opts;
  const Label = titleCase(label);
  onLog(log(`Updating the ${label}: ${from} → ${to}`));

  // Skip the registry when the target is already on the box (a manual build, a
  // prior pull, or offline) — a differing tag whose image is present is ready to run.
  if (!(await imageExistsLocally(executor, to))) {
    if (managedImagesAreFromSource(kind)) {
      // A from-source (dev) tag is unpublished — if it isn't on the box the
      // control-plane build/ship didn't complete. Pulling can only 404, so stay on
      // the current image and say why, rather than a misleading registry error.
      onLog(log(fromSourceImageMissingMessage(label, to), "warn"));
      return { swapped: false, down: false };
    }
    const pull = await executor.streamExec(`docker pull ${sq(to)}`, onLog as (l: LogEntry) => void);
    if (pull.code !== 0) {
      // Nothing was torn down yet — the old image is still serving.
      onLog(log(`Could not pull ${to} — the ${label} stays on ${from}.`, "warn"));
      return { swapped: false, down: false };
    }
  }

  if (await start(to)) {
    onLog(log(`${Label} updated to ${to}`));
    return { swapped: true, down: false };
  }

  onLog(log(`${Label} ${to} failed to come up — rolling back to ${from}...`, "error"));
  if (await start(from)) {
    // Rolled back cleanly: not updated, but still serving on the old image.
    return { swapped: false, down: false };
  }
  onLog(log(`Rollback to ${from} ALSO failed — the ${label} is down on this server.`, "error"));
  return { swapped: false, down: true };
}
