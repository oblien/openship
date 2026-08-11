/**
 * Compose LONG-FORM mounts and ports, folded back into the single short-form
 * string openship stores.
 *
 * A service row keeps `volumes`/`ports` as compose short-form strings
 * (`src:target:ro`, `127.0.0.1:8080:80/udp`), because that is what
 * `HostConfig.Binds` and `PortBindings` are built from. Compose's long form says
 * the same things as nested fields, so every importer has to fold one into the
 * other — and there are two importers: the API's YAML parser and the CLI's
 * `docker compose config --format json` reader.
 *
 * They folded it differently, which is the whole reason this module exists. The
 * CLI's version dropped `read_only`, and because `docker compose config` ALWAYS
 * normalizes to long form, every `:ro` a compose file declared was lost on
 * `openship service sync` — a host directory the author marked read-only was
 * bind-mounted writable, with nothing reporting it (#533). Same class for
 * `host_ip`: the CLI dropped the bound interface the API preserved.
 *
 * So the folding lives in exactly one place. A field added here reaches both
 * importers or neither; it can no longer reach one and not the other.
 *
 * Pure string logic, no dependencies.
 */

/** Identity — the CLI's input is already interpolated by `docker compose config`. */
const asIs = (s: string) => s;

/**
 * Long-form mount object → short-form spec, or undefined when it isn't one.
 *
 * The mode suffix carries read-only/SELinux/nocopy intent, and `read_only` WINS
 * over the others when a mount sets more than one: the downstream MODE_SUFFIX
 * regex matches a single flag, and of the possible wrong answers, silently
 * granting write access is the worst one.
 *
 * `interpolate` applies to the values compose leaves as `${VAR}` in a raw YAML
 * read; callers whose input is already resolved omit it. Deliberately NOT applied
 * to `source`/`target` — that matches the existing YAML parser exactly, and
 * changing it belongs to whoever wants long-form source interpolation, not here.
 */
export function composeMountToSpec(
  mount: Record<string, unknown>,
  interpolate: (value: string) => string = asIs,
): string | undefined {
  const source = mount.source ?? mount.name;
  const target = mount.target;

  const bindOpts = mount.bind as Record<string, unknown> | undefined;
  const volumeOpts = mount.volume as Record<string, unknown> | undefined;
  const selinux = typeof bindOpts?.selinux === "string" ? bindOpts.selinux : undefined;
  const mode =
    mount.read_only === true
      ? ":ro"
      : volumeOpts?.nocopy === true
        ? ":nocopy"
        : selinux === "z" || selinux === "Z"
          ? `:${selinux}`
          : "";

  if (source && target) return `${source}:${target}${mode}`;
  // No source = an anonymous volume, which is a BARE container path and cannot
  // carry a mode: Docker parses a 2-segment bind as `source:target` and rejects it
  // outright when the second segment is a mode word ("Destination + Mode is not a
  // valid volume"). So appending one here would not produce a read-only anonymous
  // volume, it would fail the container create. The mode is dropped, and the
  // parser reports it as an unsupported mount option instead of it vanishing.
  if (target) return String(target);
  return undefined;
}

/** A long-form mount option that {@link composeMountToSpec} cannot carry. */
export type ComposeMountIssue = {
  /** The key as the file spells it, e.g. `volumes[].type=tmpfs`. */
  field: string;
  reason: string;
  /** The importer must REFUSE rather than continue — see below. */
  blocking?: boolean;
};

/**
 * Mount options the short-form spec cannot express, with the ones that must refuse
 * the import marked.
 *
 * Shared for the same reason the fold is: both importers need the identical answer.
 * `openship service sync` originally refused only `network_mode: host`, so the same
 * compose file was accepted by the CLI and rejected by the API — a divergence that
 * is worse than either policy alone.
 *
 * BLOCKING means the mount would land as a different KIND of thing than the file
 * asked for, invisibly:
 *   - `type: tmpfs` has no source, so it reaches `HostConfig.Binds` as a bare
 *     container path — which Docker reads as an anonymous volume. A RAM-backed,
 *     ephemeral, size-capped mount silently becomes persistent disk.
 *   - `volume.subpath` scopes the mount to ONE directory inside a volume. Ignoring
 *     it mounts the whole volume there, exposing the siblings the file scoped out.
 * The rest are warnings: the mount still lands, just without the extra.
 *
 * `target` is used only to word the message; pass whatever the mount declares.
 */
export function composeMountIssues(mount: Record<string, unknown>): ComposeMountIssue[] {
  const issues: ComposeMountIssue[] = [];
  const target = typeof mount.target === "string" ? mount.target : "<unnamed>";

  const type = typeof mount.type === "string" ? mount.type : undefined;
  if (type === "tmpfs") {
    return [
      {
        field: "volumes[].type=tmpfs",
        reason:
          `the tmpfs mount at ${target} is not modeled. Openship mounts volumes and ` +
          `host paths only, so this would be created as a persistent volume on disk ` +
          `rather than in memory — remove it or make it a named volume deliberately.`,
        blocking: true,
      },
    ];
  }
  if (type === "npipe" || type === "cluster" || type === "image") {
    return [
      {
        field: `volumes[].type=${type}`,
        reason: `the ${type} mount at ${target} is not modeled.`,
        blocking: true,
      },
    ];
  }

  const volumeOpts = mount.volume as Record<string, unknown> | undefined;
  if (typeof volumeOpts?.subpath === "string" && volumeOpts.subpath) {
    issues.push({
      field: "volumes[].volume.subpath",
      reason:
        `volume.subpath on the mount at ${target} is not modeled. Ignoring it would ` +
        `mount the ENTIRE volume there instead of the one subdirectory, exposing ` +
        `data the file scoped out.`,
      blocking: true,
    });
  }

  // An anonymous volume is a bare container path in `Binds`, which has nowhere to
  // put a mode — Docker rejects `path:ro` as a malformed 2-segment bind rather than
  // reading it as read-only. So the flag is dropped, and said out loud here.
  if (mount.read_only === true && !mount.source && !mount.name) {
    issues.push({
      field: "volumes[].read_only",
      reason:
        `read_only on the anonymous volume at ${target} is not modeled — a volume ` +
        `with no source cannot be mounted read-only. Give it a named source to make ` +
        `it read-only.`,
    });
  }

  const bindOpts = mount.bind as Record<string, unknown> | undefined;
  if (typeof bindOpts?.propagation === "string" && bindOpts.propagation) {
    issues.push({
      field: "volumes[].bind.propagation",
      reason: `bind.propagation on the mount at ${target} is not modeled.`,
    });
  }
  if (bindOpts?.create_host_path === false) {
    issues.push({
      field: "volumes[].bind.create_host_path",
      reason:
        `create_host_path: false on the mount at ${target} is not modeled — Docker ` +
        `will create the host path if it is missing.`,
    });
  }

  return issues;
}

/**
 * Long-form port object → short-form spec, or undefined when it isn't one.
 *
 * Both separated fields are folded back so the string form is lossless:
 * `protocol` becomes the trailing `/udp`, and `host_ip` becomes the leading
 * `<ip>:` segment. Dropping `host_ip` is not cosmetic — an author who wrote
 * `127.0.0.1:8080:80` asked for a loopback-only publish, and the bare `8080:80`
 * it degrades to means something different.
 */
export function composePortToSpec(
  port: Record<string, unknown>,
  interpolate: (value: string) => string = asIs,
): string | undefined {
  const target = port.target ?? port.container_port;
  if (target === undefined || target === null || target === "") return undefined;

  const published = port.published ?? port.host_port;
  const proto = typeof port.protocol === "string" ? port.protocol.toLowerCase() : undefined;
  const suffix = proto && proto !== "tcp" ? `/${proto}` : "";
  const hostIp = typeof port.host_ip === "string" ? interpolate(port.host_ip) : undefined;

  // `0` counts as UNPUBLISHED, matching what the YAML parser did before this fold
  // was extracted. Both spellings end up on an ephemeral host port anyway (Docker
  // reads HostPort "0" and "" identically), so the reading that changes no existing
  // behavior is the right one.
  const hasPublished =
    published !== undefined && published !== null && published !== "" && published !== 0 && published !== "0";
  const hostPart = hasPublished
    ? hostIp
      ? `${hostIp}:${published}:`
      : `${published}:`
    : hostIp
      ? `${hostIp}::`
      : "";

  return `${hostPart}${target}${suffix}`;
}
