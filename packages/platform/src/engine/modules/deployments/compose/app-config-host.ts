/**
 * Where an app template's generated config files (`advanced.files`) live, and which
 * executor is allowed to write them.
 *
 * These files are bind-mounted read-only into the service container (Kong's
 * `kong.yml`, a Postgres init `.sql`), and Docker resolves bind sources on the
 * machine running the DAEMON. So they are host state, unavoidably: a file written to
 * the api container's own filesystem looks written, and then Docker mounts an empty
 * directory over the path the service expects a file at — the container starts and
 * dies with a config error that names neither the file nor the reason (#490).
 *
 * Unlike the static release tree, this root is deliberately NOT bind-mounted into the
 * api container (see EDGE_CONTAINER_MOUNTS): a mount would only ever be right for the
 * local box, and would quietly do the wrong thing the moment the target is a remote
 * server. Choosing the executor per target is the honest version of that, which is
 * what this module is for.
 */

import type { CommandExecutor } from "@repo/adapters";
import { shellQuote } from "@repo/core";
import { randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";

import { sshManager } from "../../../lib/ssh-manager";
import { assertValidGeneratedConfigFiles } from "../../../lib/generated-config-files";

/**
 * Persistent on-host root for app template config files. Sibling of the other
 * openship host state (`/var/lib/openship/ssh-keys`); overridable for hosts that keep
 * openship state elsewhere. Files land at
 * `<root>/<projectId>/<service>/<container-path>` — the executor creates parent dirs —
 * and the container-absolute path is appended verbatim so binds are unique and
 * self-describing.
 */
export const APP_CONFIG_HOST_ROOT =
  process.env.OPENSHIP_APP_CONFIG_DIR || "/var/lib/openship/app-config";

function safeHostSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized === "." || sanitized === ".." ? "_" : sanitized;
}

export function appConfigHostServiceRoot(projectId: string, serviceName: string): string {
  return `${APP_CONFIG_HOST_ROOT}/${safeHostSegment(projectId)}/${safeHostSegment(serviceName)}`;
}

export function appConfigHostPath(
  projectId: string,
  serviceName: string,
  containerPath: string,
): string {
  assertValidGeneratedConfigFiles([{ path: containerPath, content: "" }]);
  const rel = containerPath.replace(/^\/+/, "");
  return `${appConfigHostServiceRoot(projectId, serviceName)}/${rel}`;
}

/**
 * Run `fn` with an executor that reaches the machine whose Docker daemon will mount
 * these files, or report that nothing can.
 *
 * The local box goes through the host channel rather than `platform.executor`: for a
 * plain local target that executor is a `LocalExecutor`, which on a Compose install is
 * the api CONTAINER's filesystem — see the module note. `withHostExecutor` resolves to
 * that same local executor on a bare install, so this is a no-op there, and it throws
 * (rather than writing to the wrong machine) when the api is containerized with no
 * usable channel.
 *
 * Cloud mounts no host paths at all, and a remote target with no executor is nothing
 * we can reach — both report `ran: false` so the caller can say so per service.
 */
export async function withAppConfigHost(
  opts: { executor?: CommandExecutor | null; localHost?: boolean; isCloud: boolean },
  fn: (host: CommandExecutor) => Promise<void>,
): Promise<{ ran: boolean }> {
  if (opts.isCloud) return { ran: false };
  if (opts.localHost) {
    await sshManager.withHostExecutor(fn);
    return { ran: true };
  }
  if (!opts.executor) return { ran: false };
  await fn(opts.executor);
  return { ran: true };
}

/**
 * Write one generated config file, failing with the REQUIREMENT rather than the
 * symptom.
 *
 * When a host firewall drops the container→host channel (#490) the raw failure is an
 * SSH timeout, or a "No such file" naming a path that looks like it should exist —
 * neither of which points at the channel. The deploy MUST still fail (a service whose
 * `kong.yml` never landed starts and then dies); it just has to fail legibly.
 */
export async function writeAppConfigFile(
  writer: CommandExecutor,
  hostPath: string,
  content: string,
  serviceName: string,
  containerPath: string,
  opts?: { mode?: number; privateDirectory?: string },
): Promise<void> {
  const stagedPath = `${hostPath}.openship-${randomUUID()}.tmp`;
  try {
    if (!writer.rename) {
      throw new Error("target file channel does not support atomic rename");
    }
    // The mounted file itself must remain readable by images that deliberately
    // run as a non-root UID (Kong, Postgres, ...). Protect secrets from other
    // host users at the directory boundary instead; Docker's root daemon can
    // still traverse it and bind the 0644 file into the container.
    const parent = pathPosix.dirname(hostPath);
    const privateDirectory = opts?.privateDirectory ?? parent;
    await writer.mkdir(privateDirectory);
    await writer.exec(`chmod 0700 -- ${shellQuote(privateDirectory)}`);
    // Replace through a sibling inode. Existing containers keep their current
    // bind-mounted inode until they are replaced; a failed/partial write never
    // truncates the config underneath the live workload.
    await writer.writeFile(stagedPath, content, { mode: opts?.mode ?? 0o644 });
    await writer.rename(stagedPath, hostPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Service "${serviceName}": couldn't write its generated config file ${containerPath} to ` +
        `${hostPath} on the deploy target. Docker mounts this file by HOST path, so it has to ` +
        `be written on the machine running the containers — the usual causes are that Openship ` +
        `can't reach that machine, or can't write that path. Underlying error: ${detail}`,
    );
  } finally {
    await writer.rm?.(stagedPath).catch(() => undefined);
  }
}
