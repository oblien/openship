import type { CommandExecutor, LogEntry } from "../types";
import { logEntry, sq } from "./local-shell";
import { edgeFailureReason, resolveOurEdgeContainer } from "./proxy/detect";
import { explainEdgeDown, isEdgeDownFailure } from "./edge-exec-error";

/** Wrap a command so it runs INSIDE the named edge container. */
export function containerCommand(container: string, command: string): string {
  return `docker exec ${sq(container)} sh -c ${sq(command)}`;
}

/**
 * Ask the HOST why the edge container refused a command, and say it in one line.
 *
 * `inner` is the host executor — the same channel the `docker exec` went out on — so
 * this works over SSH to a remote server with no second Docker client and no tunnel.
 * Both probes are best-effort: a partial answer ("restarting", no reason) still beats
 * the daemon's bare container id, and a probe that fails must not replace the real
 * failure with an error about diagnosing it.
 */
async function diagnoseEdgeDown(inner: CommandExecutor, container: string): Promise<string> {
  const status = await inner
    .exec(`docker inspect -f '{{.State.Status}}' ${sq(container)} 2>/dev/null`)
    .catch(() => null);
  const logs = await inner
    .exec(`docker logs --tail 40 ${sq(container)} 2>&1`)
    .catch(() => null);
  return explainEdgeDown({
    container,
    status: status?.trim() || null,
    reason: logs ? edgeFailureReason(logs) : null,
  });
}

/**
 * Where an edge-container executor's FILE operations land.
 *
 *   "host" — the edge's state is bind-mounted from canonical host paths
 *            (EDGE_CONTAINER_MOUNTS), so file ops pass straight through to the
 *            inner executor. The default, and the right answer for any edge this
 *            codebase installs: `ensureContainerEdge` creates those mounts.
 *   "auto" — the state may NOT be visible on the host (a legacy install on
 *            Docker-managed named volumes), so prefer the host and reach into the
 *            container when the host can't answer. Same rule, same code, as the
 *            standalone {@link readEdgeFile} / {@link writeEdgeFile}.
 */
export type EdgeFilesAt = "host" | "auto";

/**
 * The edge container, either already known or resolvable on demand. A thunk lets
 * the read path skip the `docker ps` entirely when the host answers — which is
 * every non-legacy box.
 */
export type EdgeContainerRef = string | null | (() => Promise<string | null>);

function resolveRef(
  ref: EdgeContainerRef | undefined,
): Promise<string | null> | string | null | undefined {
  return typeof ref === "function" ? ref() : ref;
}

/**
 * Read a file a proxy owns (a cert, a vhost) from wherever its state actually
 * lives, on the box `exec` reaches. `container` is the fallback — a name, null/
 * absent when there is none, or a thunk that resolves one on demand.
 *
 * Canonical location is the HOST — certs live at `/etc/letsencrypt` and vhosts at a
 * bind-mounted dir, so a plain read is right for a bare edge and for a containerized
 * one on current mounts. A containerized proxy may instead keep that state in a
 * Docker-managed named volume the host can't see, where a host read returns nothing
 * and is indistinguishable from "no cert" — so fall back to reading inside the
 * container. Never throws: "" means nothing to reuse, which is what every caller
 * already treats as absence.
 *
 * This is the ONE implementation of that rule, for OUR edge and for a FOREIGN proxy
 * alike — the two only differ in which container they name, not in how the file is
 * found. Three doors reach it and none may answer differently for the same box:
 * `readEdgeFile` (our edge, resolved lazily), a plain container name (a foreign
 * proxy being imported/migrated), and `files: "auto"` on `edgeContainerExecutor`.
 */
export async function readMaybeInContainer(
  exec: CommandExecutor,
  path: string,
  container?: EdgeContainerRef,
): Promise<string> {
  const direct = await exec.readFile(path).catch(() => "");
  if (direct.trim()) return direct;
  // Resolved only NOW, on the miss: the overwhelmingly common case is a host hit,
  // and it must not pay for a `docker ps` to answer a question it never asks.
  const name = await resolveRef(container);
  if (!name) return "";
  return exec.exec(containerCommand(name, `cat ${sq(path)}`)).catch(() => "");
}

/**
 * Write a file the edge must be able to read, wherever its state actually lives.
 * Counterpart to {@link readMaybeInContainer} — see there for why this exists once.
 *
 * Writes to the canonical host path first, then asks the container whether it can
 * see it. A bind mount answers yes and we're done; a named volume answers no, and
 * the file gets copied in — otherwise the write lands on a path the edge never looks
 * at and silently does nothing (how carried migration certs went missing).
 * Best-effort on the container leg: the host write is the contract.
 */
async function writeEdgeFileIn(
  inner: CommandExecutor,
  container: string | null,
  path: string,
  content: string,
): Promise<void> {
  await inner.writeFile(path, content);
  if (!container) return;
  const visible = await inner
    .exec(containerCommand(container, `test -e ${sq(path)} && echo visible`))
    .catch(() => "");
  if (visible.trim() === "visible") return;
  const dir = path.replace(/\/[^/]*$/, "");
  if (dir && dir !== path) {
    await inner.exec(containerCommand(container, `mkdir -p ${sq(dir)}`)).catch(() => {});
  }
  await inner.exec(`docker cp ${sq(path)} ${sq(`${container}:${path}`)}`).catch(() => {});
}

/**
 * {@link readMaybeInContainer} pointed at OUR edge — for a caller that has an
 * executor but no container name. The thunk is the point: our container is
 * resolved only if the host read misses.
 */
export function readEdgeFile(exec: CommandExecutor, path: string): Promise<string> {
  return readMaybeInContainer(exec, path, () => resolveOurEdgeContainer(exec).catch(() => null));
}

/**
 * {@link writeEdgeFileIn} for a caller that has an executor but no container name.
 * Unlike the read path this always resolves, because deciding whether to copy in
 * requires asking the container what it can see.
 */
export async function writeEdgeFile(
  exec: CommandExecutor,
  path: string,
  content: string,
): Promise<void> {
  const container = await resolveOurEdgeContainer(exec).catch(() => null);
  return writeEdgeFileIn(exec, container, path, content);
}

/**
 * Decorate a CommandExecutor so it drives a CONTAINERIZED OpenResty edge on the
 * box that executor reaches — the shell counterpart of `DockerEdgeExecutor`,
 * which needs a dockerode client and therefore only works where the daemon socket
 * is directly reachable. This one goes through `docker exec` over whatever channel
 * the inner executor already has (typically the pooled SSH executor for a remote
 * server), so no tunnel and no second Docker client are involved.
 *
 * Commands (`openresty -t`, `-s reload`, `certbot`) ALWAYS run inside the
 * container. Where FILES go is the caller's choice — see {@link EdgeFilesAt}; the
 * default `"host"` is correct for every edge `ensureContainerEdge` creates, because
 * it creates the bind mounts.
 *
 * Privilege is the caller's problem, exactly as with `probeEdge`'s own
 * `docker ps`: pass an already-elevated inner executor if the SSH user needs
 * sudo to reach the daemon.
 *
 * A Proxy forwards every other (optional) executor method — rawExec, forwardPort,
 * openShell, onDisconnect, dispose — transparently to the inner executor.
 */
export function edgeContainerExecutor(
  inner: CommandExecutor,
  container: string,
  opts?: { files?: EdgeFilesAt },
): CommandExecutor {
  const inContainer = (command: string) => containerCommand(container, command);

  const overrides: Partial<CommandExecutor> = {
    // Both command paths enrich a "the container isn't up" failure with the
    // container's name, state and `[emerg]` — see `diagnoseEdgeDown`. Gated on the
    // narrow daemon/nginx signatures (`isEdgeDownFailure`), because a non-zero exit
    // is ordinary here: the container-file probes report a missing path that way, and
    // paying two `docker` round-trips per miss would be a real cost on every read.
    exec: async (command: string, execOpts?: { timeout?: number }) => {
      try {
        return await inner.exec(inContainer(command), execOpts);
      } catch (err) {
        const message = (err as { message?: string })?.message ?? String(err);
        if (!isEdgeDownFailure(message)) throw err;
        throw new Error(`${await diagnoseEdgeDown(inner, container)}\n${message}`);
      }
    },
    // streamExec REPORTS failure instead of throwing it, and its callers build the
    // error they raise out of what was streamed (`_execCertbot` accumulates the log
    // lines and throws that text). So the explanation has to go through `onLog` to
    // reach them — appending it only to the return value would leave certbot's
    // caller raising the daemon's bare container id, which is the original bug.
    streamExec: async (command: string, onLog: (log: LogEntry) => void, opts?: { signal?: AbortSignal }) => {
      const result = await inner.streamExec(inContainer(command), onLog, opts);
      if (result.code === 0 || !isEdgeDownFailure(result.output)) return result;
      const explanation = await diagnoseEdgeDown(inner, container);
      onLog(logEntry(explanation, "error"));
      return { code: result.code, output: `${explanation}\n${result.output}` };
    },
    // A rename is a FILE op, so it follows the files, never the commands. Stated
    // here rather than left to the Proxy's passthrough: if the inner executor has no
    // `rename`, the fallback must still be the INNER shell (the host) — routing it
    // through this decorator's `exec` would put a `mv` inside the container, where
    // the host path it was handed does not exist.
    rename: async (from: string, to: string) => {
      if (inner.rename) return inner.rename(from, to);
      await inner.exec(`mv ${sq(from)} ${sq(to)}`);
    },
  };

  if (opts?.files === "auto") {
    // Deliberately the SAME functions the standalone readEdgeFile/writeEdgeFile
    // use — the container is already resolved here, so it's the identical decision
    // with one probe saved.
    Object.assign(overrides, {
      readFile: (path: string) => readMaybeInContainer(inner, path, container),
      writeFile: (path: string, content: string) =>
        writeEdgeFileIn(inner, container, path, content),
      exists: async (path: string) => {
        if (await inner.exists(path).catch(() => false)) return true;
        // `test` reports absence via exit code — an answer, not a failure.
        const { code } = await inner.streamExec(inContainer(`test -e ${sq(path)}`), () => {});
        return code === 0;
      },
      // The rename half of an atomic write must land in the same namespace as the
      // write itself, so it follows readFile/writeFile — host first, container only
      // when the host can't see the file.
      rename: async (from: string, to: string) => {
        if (await inner.exists(from).catch(() => false)) {
          if (inner.rename) return inner.rename(from, to);
          await inner.exec(`mv ${sq(from)} ${sq(to)}`);
          return;
        }
        await inner.exec(inContainer(`mv ${sq(from)} ${sq(to)}`));
      },
      // mkdir/rm are idempotent and rare (route register/deregister), so both homes
      // get them unconditionally rather than paying a probe to decide.
      mkdir: async (path: string) => {
        await inner.mkdir(path);
        await inner.exec(inContainer(`mkdir -p ${sq(path)}`)).catch(() => {});
      },
      rm: async (path: string) => {
        await inner.rm(path);
        await inner.exec(inContainer(`rm -rf ${sq(path)}`)).catch(() => {});
      },
    } satisfies Partial<CommandExecutor>);
  }

  return new Proxy(inner, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return (overrides as Record<string | symbol, unknown>)[prop];
      }
      // Bind to the REAL inner (not the proxy) so delegated methods never
      // re-enter the container layer.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
