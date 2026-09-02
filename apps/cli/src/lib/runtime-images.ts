/**
 * Openship's own control-plane images on THIS host — `openship-api`,
 * `openship-dashboard`, `openship-edge` under whatever registry the compose stack
 * pins (`OPENSHIP_IMAGE_REGISTRY`, default ghcr.io/oblien).
 *
 * `openship update` pulls the new tag and recreates the stack but never removes
 * the previous one, so every upgrade leaves a full api + dashboard + edge behind
 * (#779). These carry no `openship.project` label, so the API-side built-image
 * GC — deliberately label-scoped — can never touch them either. This is the
 * host-local sibling: list them, keep the version a container references plus
 * `keepPrevious` more for a quick downgrade, and mark the rest. Removal is the
 * command's job and only ever on an explicit `--prune`; nothing referenced by a
 * container, running OR stopped, is ever a candidate.
 *
 * Pure decision logic here so it is unit-testable; the docker calls live in
 * commands/system.ts.
 */

export const RUNTIME_IMAGE_NAMES = ["openship-api", "openship-dashboard", "openship-edge"] as const;

export interface HostImage {
  repository: string;
  tag: string;
  id: string;
  size: string;
  createdAt: string;
}

export type RuntimeImageReason = "in-use" | "previous" | "not-a-version" | "superseded";

export interface RuntimeImageVerdict extends HostImage {
  ref: string;
  action: "keep" | "remove";
  reason: RuntimeImageReason;
}

/** The `--format` this module's parser expects from `docker images`. */
export const DOCKER_IMAGES_FORMAT = "{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedAt}}";

export function parseDockerImages(stdout: string): HostImage[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [repository = "", tag = "", id = "", size = "", createdAt = ""] = line.split("\t");
      return { repository, tag, id, size, createdAt };
    });
}

/** `ghcr.io/oblien/openship-api`, `registry.local:5000/mirror/openship-edge`, … */
export function isRuntimeImage(repository: string): boolean {
  const name = repository.slice(repository.lastIndexOf("/") + 1);
  return (RUNTIME_IMAGE_NAMES as readonly string[]).includes(name);
}

/**
 * Image refs containers reference, from `docker ps -a --format '{{.Image}}'`.
 * Docker prints the ref the container was created with: `repo:tag`, a bare
 * `repo` (meaning `:latest`), or an id. Both spellings of an untagged ref are
 * kept so a lookup by `repo:latest` matches either way.
 */
export function parseContainerImageRefs(stdout: string): Set<string> {
  const refs = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const ref = raw.trim();
    if (!ref) continue;
    refs.add(ref);
    const slash = ref.lastIndexOf("/");
    if (!ref.slice(slash + 1).includes(":") && !ref.startsWith("sha256:"))
      refs.add(`${ref}:latest`);
  }
  return refs;
}

const VERSION_TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** Numeric dotted compare; a pre-release sorts below its release. 0 when either
 *  side isn't a version tag. */
export function compareVersionTags(a: string, b: string): number {
  const pa = VERSION_TAG.exec(a);
  const pb = VERSION_TAG.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const preA = a.includes("-");
  const preB = b.includes("-");
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}

/**
 * Per repository, newest first: anything a container references is kept
 * (`in-use`), the next `keepPrevious` versions are kept (`previous`), the rest
 * are `superseded`. A tag that isn't a version (`latest`, a branch name) is
 * never a candidate — we can't order it, so we can't call it old.
 */
export function planRuntimeImagePrune(
  images: HostImage[],
  opts: { inUse: ReadonlySet<string>; keepPrevious: number },
): RuntimeImageVerdict[] {
  const byRepo = new Map<string, HostImage[]>();
  for (const img of images) {
    if (!isRuntimeImage(img.repository) || img.tag === "<none>") continue;
    const group = byRepo.get(img.repository) ?? [];
    group.push(img);
    byRepo.set(img.repository, group);
  }

  const out: RuntimeImageVerdict[] = [];
  for (const repository of [...byRepo.keys()].sort()) {
    const group = byRepo.get(repository)!;
    const sorted = [...group].sort((x, y) => compareVersionTags(y.tag, x.tag));
    let spare = Math.max(0, opts.keepPrevious);
    for (const img of sorted) {
      const ref = `${img.repository}:${img.tag}`;
      const verdict = (action: "keep" | "remove", reason: RuntimeImageReason) =>
        out.push({ ...img, ref, action, reason });
      if (opts.inUse.has(ref) || opts.inUse.has(img.id)) verdict("keep", "in-use");
      else if (!VERSION_TAG.test(img.tag)) verdict("keep", "not-a-version");
      else if (spare > 0) {
        spare -= 1;
        verdict("keep", "previous");
      } else verdict("remove", "superseded");
    }
  }
  return out;
}
