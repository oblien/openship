/**
 * Docker runtime - manages containers via the Docker Engine API (dockerode).
 *
 * Supports three connection modes:
 *   - Local socket (default, zero config)
 *   - Remote via SSH tunnel (ssh2 streamlocal forwarding to Docker socket)
 *   - Remote via TCP + mutual TLS
 *
 * This is ONLY the runtime. Routing (Nginx) and SSL (certbot) are separate
 * infrastructure providers - see `infra/`.
 *
 * Build strategy:
 *   Builds from a staged source context sent to the Docker daemon. If the
 *   repository already provides a Dockerfile, that becomes the source of
 *   truth. Otherwise Openship generates a minimal builder Dockerfile.
 *   Deploy creates a container from the resulting image.
 *
 * SECURITY MODEL:
 *   - SSH: uses the same configured credentials as the standard SSH executor
 *     (password, private key, or SSH agent).
 *   - SSH keys should be encrypted at rest and decrypted in memory only.
 *   - Host fingerprints can be pinned via `hostVerifier` (TOFU or strict).
 *   - TCP: mutual TLS (client cert + CA) - no plaintext TCP.
 */

// `tar-fs` ships no types and `@types/tar-fs` isn't vendored; this reference
// pulls in our local ambient declaration so tsc sees it whether the adapters
// package compiles itself (its `src/**` glob) OR a consumer (the API) reaches
// this file only through import resolution and never scans our src for stray
// `.d.ts` files (#448).
/// <reference path="./tar-fs.d.ts" />
import Dockerode from "dockerode";
import * as tarFs from "tar-fs";
import { createGzip } from "node:zlib";

import type {
  BuildConfig,
  ImageArtifactConfig,
  CommandExecutor,
  DeployConfig,
  BuildResult,
  DeploymentResult,
  LogEntry,
  LogCallback,
  ContainerInfo,
  ContainerStatus,
  ResourceUsage,
  ShellOptions,
  ShellSession,
  ProvisionLock,
} from "../types";
import type { PortProbeExecutor } from "../system/port-listen";
import { PassThrough, Writable, type Readable } from "node:stream";
import { relative, sep } from "node:path";
import { resolveDockerBuildArgs } from "./docker-build-args";

/**
 * Detect "not found" errors from the Docker SDK (dockerode). The daemon
 * returns HTTP 404 for missing containers/images/volumes/networks. Used to make
 * destroy / removeImage idempotent across partial-cleanup retries, and to
 * distinguish ABSENT (drift / idempotent success) from UNREACHABLE. Shared
 * implementation lives in system/errors so the reconcile/cleanup paths key off
 * the same rule.
 */
const isDockerNotFoundError = isRuntimeNotFoundError;

/**
 * Is this image tag one WE built, and therefore ours to delete?
 *
 * Only `openship/…` tags are (see `imageTag`), and every build mints a globally
 * unique one (`openship/<slug>:<session>`), so exactly one deployment row ever
 * owns a given tag. Anything else is either pulled from a registry
 * (`postgres:17`) or adopted by a docker-migration import — and those two are
 * precisely the tags that must NOT be deleted by row:
 *
 *   - a migration import reuses ONE mutable, registry-less tag across every
 *     sibling service, so untagging it for one row strands the others with a
 *     tag that no longer resolves and cannot be re-pulled;
 *   - a registry tag is shared with anything else on the box using it, and
 *     deleting it buys nothing (it re-pulls).
 *
 * This mirrors the safety model `image-gc` already documents — it only ever
 * considers images carrying the `openship.project` label, which `labels()`
 * stamps on final build images and never on pulled/adopted ones. Structural, so
 * it needs no daemon round-trip: the caller's keep-set answers "does another
 * RETAINED release need this tag", and this answers "is it even ours".
 */
export function ownsBuiltImage(imageRef: string): boolean {
  // `imageTag()` always uses the reserved local namespace AND a generated
  // build-session tag. Prefix-only matching would misclassify a legitimate
  // Docker Hub image such as `openship/agent:v1` as ours and allow cleanup to
  // untag registry content that this deployment never built.
  return /^openship\/[a-z0-9][a-z0-9._-]*:bld_[A-Za-z0-9_-]+$/.test(imageRef);
}

/** Clamp a terminal window dimension to a sane min/max with default. */
function clampShellWindow(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.isFinite(value) ? Number(value) : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}
import type { Feature, SystemLog } from "../system/types";
import { isRuntimeNotFoundError } from "../system/errors";
import { OPENSHIP_LABEL } from "../system/port-owner";
import { dirOf, ensureOwnedDir } from "../system/elevated-executor";
import { dockerConfigJsonFor, registryForImage, resolveDockerAuth } from "./docker-auth";

import type {
  RuntimeAdapter,
  RuntimeCapability,
  MultiServiceGroupHandle,
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  DeploymentRef,
  DockerContainerSummary,
  DockerContainerDetail,
  DockerMount,
  DockerPortBinding,
  DockerVolumeInfo,
  DockerNetworkInfo,
  ContainerLifecycleEvent,
} from "./types";
import {
  BuildCancelledError,
  BuildLogger,
  killProcessesUnderDir,
  parseLogLevel,
  sq,
  assembleGitClone,
} from "./build-pipeline";
import { materializeGitSsh, shellGitSshWriter, type GitSshMaterial } from "./git-ssh-material";
import { isArtifactPathRef, removeManagedArtifact } from "./managed-artifact";
import { githubTarballUrl, downloadTarballOnRemote } from "./source-tarball";
import { scopeVolumeBinds, isHostPathSource } from "./volume-namespace";
import {
  createDockerBuildContext,
  missingContextDockerfileMessage,
  prepareSourceTree,
  resolveServiceDockerfile,
} from "./docker-build-context";
import { BuildKitTraceDecoder } from "./docker-buildkit-trace";
import {
  startExecStream,
  daemonConnectionFrom,
  installDockerodeBuildKitSessionWorkaround,
} from "./docker-exec-stream";
import { resolveComposeCmd, resolveComposeEntrypoint } from "./compose-cmd";
import {
  dockerBuildContextDirectory,
  normalizeDockerRelativePath,
  resolveContextDockerfileCandidates,
  resolveDockerfileCandidates,
} from "./docker-paths";
import type { ContainerStabilitySample } from "./stability";
import {
  builderContextRoot,
  generateDockerfile,
  isExcludedDocRootEntry,
  staticBuilderOutputPath,
} from "./docker-build-plan";
import { transferLocalDirectory } from "./transfer";
import { splitRuntimeEnv, droppedRuntimeEnvMessage } from "./runtime-env";
import {
  ownsNetworkEndpoint,
  safeErrorMessage,
  type ComposeAdvanced,
  type ComposeHealthcheck,
} from "@repo/core";
import {
  dockerResourceLimits,
  dockerBuildResourceLimits,
  describeResourceLimits,
  inspectResourceLimits,
} from "./resource-limits";
import {
  type DockerConnectionOptions,
  type DockerTransport,
  resolveDockerTransport,
} from "./docker-transport";

// ─── Connection config ───────────────────────────────────────────────────────
export type { DockerConnectionOptions } from "./docker-transport";

interface DockerSystemManager {
  ensureFeature(feature: Feature, onLog?: (log: SystemLog) => void): Promise<void>;
}

// ─── Shared Docker helpers ───────────────────────────────────────────────────

const RESTART_POLICIES: Record<string, { Name: string; MaximumRetryCount: number }> = {
  always: { Name: "always", MaximumRetryCount: 0 },
  "on-failure": { Name: "on-failure", MaximumRetryCount: 5 },
  "unless-stopped": { Name: "unless-stopped", MaximumRetryCount: 0 },
  no: { Name: "no", MaximumRetryCount: 0 },
};

const DOCKER_BUILD_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * A deployment build and its cancellation request may resolve separate
 * DockerRuntime instances — the cancel endpoint takes `platform().runtime`, not
 * the per-server runtime that ran the build. Build session ids are process-wide
 * and globally unique, so cancellation state must be process-wide too or the
 * cancelling runtime cannot reach the builder's controller.
 */
const activeDockerBuilds = new Map<string, AbortController>();
const pendingDockerBuildCancellations = new Map<string, ReturnType<typeof setTimeout>>();

/** How long a cancel that landed before its build waits for that build to start. */
const PENDING_CANCEL_TTL_MS = 10 * 60 * 1000;

/**
 * Cancelling `<parent>` also cancels every `<parent>-<serviceId>` sub-build: a
 * compose deploy builds one image per service under that derived id, while the
 * cancel endpoint only ever knows the parent build-session id.
 */
function cancelCovers(cancelledId: string, sessionId: string): boolean {
  return sessionId === cancelledId || sessionId.startsWith(`${cancelledId}-`);
}

/**
 * Remember a cancel whose build hasn't registered yet, so the build exits instead
 * of starting work.
 *
 * Entries EXPIRE rather than being consumed on first match: one compose cancel has
 * to reach every per-service build that hasn't started, so no single build can own
 * the entry. Nothing else would ever evict it — a build session id is single-use,
 * so a surviving entry can't cancel an unrelated build, but the map would grow for
 * the life of the process.
 */
function recordPendingCancellation(sessionId: string): void {
  clearTimeout(pendingDockerBuildCancellations.get(sessionId));
  const timer = setTimeout(
    () => pendingDockerBuildCancellations.delete(sessionId),
    PENDING_CANCEL_TTL_MS,
  );
  // Never let a pending cancel hold the process open.
  (timer as { unref?: () => void }).unref?.();
  pendingDockerBuildCancellations.set(sessionId, timer);
}

/** Register a build as active; the controller comes pre-aborted if a cancel beat it here. */
function registerDockerBuild(sessionId: string): AbortController {
  const abort = new AbortController();
  for (const cancelledId of pendingDockerBuildCancellations.keys()) {
    if (cancelCovers(cancelledId, sessionId)) {
      abort.abort();
      break;
    }
  }
  activeDockerBuilds.set(sessionId, abort);
  return abort;
}

/** Deregister, but only if this build still owns the slot (never evict a newer one). */
function releaseDockerBuild(sessionId: string, abort: AbortController): void {
  if (activeDockerBuilds.get(sessionId) === abort) activeDockerBuilds.delete(sessionId);
}

/** Last-resort cap for a one-shot in-container exec. Every caller passes its own
 *  (5s probe / 15s prepare step); this only guards a stream that connects and
 *  then never ends, which would otherwise hang a deploy forever. */
const DEFAULT_IN_CONTAINER_EXEC_TIMEOUT_MS = 120_000;

/** Exit status of a process killed by SIGTERM — what the watchdog below produces. */
const SIGTERM_EXIT_CODE = 143;

/**
 * Watchdog wrapper so the CONTAINER enforces the deadline, not just our end of
 * the socket.
 *
 * There is no Docker API to kill a running exec (moby#9098): destroying the local
 * stream leaves the process running inside the container, so a prepare step that
 * retries 5× used to leave 5 live `sh` processes behind. Here the wrapper shell
 * arms a `sleep`+`kill` against its own child and reports the child's status, so
 * a timeout ends the remote process too.
 *
 * Three details are load-bearing:
 *  - the command is a POSITIONAL ARGUMENT (`$1`), never spliced into this script,
 *    so `sh -c <command>` semantics stay byte-identical to the unwrapped call and
 *    there is no new quoting surface;
 *  - the watchdog's fds go to /dev/null. A backgrounded `sleep` holding a copy of
 *    the exec's stdout pipe keeps that pipe from reaching EOF, which would make
 *    every fast command block for the whole timeout instead of returning at once;
 *  - `setsid` gives the command its own PROCESS GROUP so the deadline can signal
 *    the whole tree. `$!` only ever names the intermediate `sh`, and TERMing that
 *    alone reparents the actual command to PID 1 — still running, still holding
 *    the exec's stdout, which is the exact orphan this wrapper exists to prevent.
 *    Alpine's busybox `ash` hid the bug by exec-optimizing the inner shell away;
 *    on any Debian/Ubuntu-based image (dash AND bash 5) it leaked every time.
 *    `set -m` is not an alternative: dash and busybox refuse monitor mode with
 *    "can't access tty", and bash makes it work but prints job-status noise onto
 *    the command's stderr.
 *
 * `sleep && kill` (not `;`) so an image with no `sleep` simply has no watchdog
 * instead of killing the command instantly. Same reason `setsid` is probed rather
 * than assumed: no `setsid` degrades to the old single-child kill, never to a
 * command that won't start.
 */
const IN_CONTAINER_EXEC_WATCHDOG = [
  "if command -v setsid >/dev/null 2>&1; then",
  '  setsid sh -c "$1" &',
  "  __osc=$!",
  // New session ⇒ pgid == pid, so the negative pid addresses the whole tree.
  "  __ost=-$__osc",
  "else",
  '  sh -c "$1" &',
  "  __osc=$!",
  // No group of its own here: a negative pid would hit OUR group, i.e. this
  // wrapper and the exec itself.
  "  __ost=$__osc",
  "fi",
  '{ sleep "$2" && { kill -TERM "$__ost" 2>/dev/null || kill -TERM "$__osc" 2>/dev/null; }; } >/dev/null 2>&1 &',
  "__osw=$!",
  "wait $__osc 2>/dev/null",
  "__osr=$?",
  "kill -TERM $__osw 2>/dev/null",
  "exit $__osr",
].join("\n");

/** argv for a one-shot in-container exec that kills itself after `timeoutMs`. */
export function buildInContainerExecCmd(command: string, timeoutMs: number): string[] {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return ["sh", "-c", IN_CONTAINER_EXEC_WATCHDOG, "openship-exec", command, String(seconds)];
}

/** Just the `inspect()` surface the exit-code poll needs, so both a dockerode
 *  `Exec` handle and `docker.getExec(id)` satisfy it. */
type ExecInspectable = { inspect(): Promise<Dockerode.ExecInspectInfo> };

/**
 * The exec's REAL exit code — never a guess.
 *
 * dockerode still reports `Running:true / ExitCode:null` in the window right
 * after the output stream ends, and reading that window as `?? 0` turns a FAILED
 * command into an apparent success: a truncated `pg_dump` gets stored and marked
 * good (discovered only at restore), and `./gen_key.sh` exiting 2 with "boom" on
 * stdout gets persisted AS the key. Poll for the real exit (bounded ~5s), then
 * FAIL rather than assume — an undeterminable exit code is not a success.
 *
 * Shared by `execInContainer` here and the backup dump/restore executors so the
 * "don't trust the null window" rule can't drift between them. `label` names the
 * exec in the error when the caller has an id to give (the backup path does).
 */
export async function resolveExecExitCode(exec: ExecInspectable, label?: string): Promise<number> {
  let info = await exec.inspect();
  for (let i = 0; info.Running && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    info = await exec.inspect();
  }
  const who = label ? `exec ${label}` : "exec";
  if (typeof info.ExitCode !== "number") {
    throw new Error(
      info.Running
        ? `${who} still running 5s after its output ended — exit code unknown`
        : `${who} reported no exit code`,
    );
  }
  return info.ExitCode;
}

function resolveRestartPolicy(policy?: string) {
  return RESTART_POLICIES[policy ?? "always"] ?? RESTART_POLICIES.always;
}

/**
 * The east-west DNS aliases a container answers to on its project network: the
 * primary name (service name / project slug) plus any operator-chosen extras,
 * with falsy entries and duplicates (incl. an extra equal to the primary)
 * dropped so Docker's `EndpointsConfig.Aliases` never carries a dead or repeated
 * name. Order-stable, primary first. Pure — unit-tested in docker-aliases.test.ts.
 */
export function buildNetworkAliases(primary: string, extras?: string[]): string[] {
  return [primary, ...(extras ?? [])].filter((a, i, arr) => Boolean(a) && arr.indexOf(a) === i);
}

// ── Docker discovery normalizers (label-agnostic inspection) ─────────────────

/** dockerode list/inspect Mount → normalized DockerMount. Both shapes share the
 *  Type/Name/Source/Destination/RW fields this reads. */
function normalizeDockerMount(m: {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
}): DockerMount {
  return {
    type: m.Type ?? "volume",
    ...(m.Name ? { name: m.Name } : {}),
    ...(m.Source ? { source: m.Source } : {}),
    destination: m.Destination ?? "",
    rw: m.RW !== false,
  };
}

/** Coerce dockerode Cmd/Entrypoint (string | string[] | null) → string[] | undefined. */
function toStringArray(v: string | string[] | null | undefined): string[] | undefined {
  if (v == null) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.length > 0 ? arr : undefined;
}

/** Normalized port list from a container inspect: published ports (with host
 *  bindings) from NetworkSettings.Ports, plus exposed-only ports from
 *  Config.ExposedPorts that were never published. */
function normalizeInspectPorts(data: Dockerode.ContainerInspectInfo): DockerPortBinding[] {
  const out: DockerPortBinding[] = [];
  const seen = new Set<string>();
  const parseKey = (key: string): { port: number; proto: string } | null => {
    const [portStr, proto] = key.split("/");
    const port = Number(portStr);
    return Number.isFinite(port) ? { port, proto: proto || "tcp" } : null;
  };

  const nsPorts = (data.NetworkSettings?.Ports ?? {}) as Record<
    string,
    Array<{ HostIp?: string; HostPort?: string }> | null
  >;
  for (const [key, bindings] of Object.entries(nsPorts)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    seen.add(key);
    if (bindings && bindings.length > 0) {
      for (const b of bindings) {
        out.push({
          privatePort: parsed.port,
          ...(b.HostPort ? { publicPort: Number(b.HostPort) } : {}),
          type: parsed.proto,
          ...(b.HostIp ? { ip: b.HostIp } : {}),
        });
      }
    } else {
      out.push({ privatePort: parsed.port, type: parsed.proto });
    }
  }

  // NetworkSettings.Ports is only populated while the container RUNS; a stopped
  // container reports its published ports in HostConfig.PortBindings instead.
  // Read that as a fallback so a stopped service's port mapping isn't lost.
  const hostBindings = (data.HostConfig?.PortBindings ?? {}) as Record<
    string,
    Array<{ HostIp?: string; HostPort?: string }> | null
  >;
  for (const [key, bindings] of Object.entries(hostBindings)) {
    if (seen.has(key)) continue;
    const parsed = parseKey(key);
    if (!parsed) continue;
    seen.add(key);
    if (bindings && bindings.length > 0) {
      for (const b of bindings) {
        out.push({
          privatePort: parsed.port,
          ...(b.HostPort ? { publicPort: Number(b.HostPort) } : {}),
          type: parsed.proto,
          ...(b.HostIp ? { ip: b.HostIp } : {}),
        });
      }
    } else {
      out.push({ privatePort: parsed.port, type: parsed.proto });
    }
  }

  const exposed = (data.Config?.ExposedPorts ?? {}) as Record<string, object>;
  for (const key of Object.keys(exposed)) {
    if (seen.has(key)) continue;
    const parsed = parseKey(key);
    if (parsed) out.push({ privatePort: parsed.port, type: parsed.proto });
  }
  return out;
}

/**
 * Interface an extra compose port binds when its spec pins none. Loopback, NOT
 * Docker's all-interfaces default: a compose service's ports the edge does not
 * front would otherwise land directly on the public network, bypassing the
 * edge's TLS/rate-limit/rules — and because Docker inserts its publish rules as
 * nat-table DNAT (evaluated before the filter INPUT chain), a host ufw/nftables
 * allow-list does NOT block them. Publishing publicly must be a deliberate
 * choice: write the interface into the spec ("0.0.0.0:8080:80"), preserved below.
 */
const DEFAULT_EXTRA_PORT_HOST_IP = "127.0.0.1";

/** Parse port specs ("8080:3000", "3000", "127.0.0.1:8080:80") into Docker
 *  ExposedPorts + PortBindings. Exported for unit tests. */
export function parsePortBindings(portSpecs: string[]): {
  exposedPorts: Record<string, object>;
  portBindings: Record<string, { HostIp?: string; HostPort: string }[]>;
} {
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, { HostIp?: string; HostPort: string }[]> = {};
  for (const spec of portSpecs) {
    // A protocol suffix ("/udp", "/sctp") applies to the container port and sits
    // at the very end of the spec. Strip it first, then split host:container.
    // Anything other than udp/sctp (including omitted) is tcp, matching Docker.
    const slashIdx = spec.lastIndexOf("/");
    const rawProto = slashIdx >= 0 ? spec.slice(slashIdx + 1).toLowerCase() : "";
    const protocol = rawProto === "udp" || rawProto === "sctp" ? rawProto : "tcp";
    const mapping = slashIdx >= 0 ? spec.slice(0, slashIdx) : spec;

    const parts = mapping.split(":");
    if (parts.length === 1) {
      // containerPort only → Docker assigns a random host port, bound to
      // loopback (see DEFAULT_EXTRA_PORT_HOST_IP).
      const key = `${parts[0]}/${protocol}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostIp: DEFAULT_EXTRA_PORT_HOST_IP, HostPort: "" }];
    } else {
      // [hostIp:]hostPort:containerPort. Parse from the RIGHT so both the
      // 2-part (hostPort:containerPort) and 3-part IP-scoped form
      // ("127.0.0.1:8080:80" — a loopback-only publish, which the dashboard
      // editor emits) work; anything before hostPort is the host IP.
      const containerPort = parts[parts.length - 1]!;
      const hostPort = parts[parts.length - 2]!;
      const hostIp = parts.length > 2 ? parts.slice(0, -2).join(":") : undefined;
      const key = `${containerPort}/${protocol}`;
      exposedPorts[key] = {};
      // An explicit interface (including "0.0.0.0" to publish deliberately) is
      // preserved verbatim; only a spec with no pinned interface falls back to
      // loopback rather than Docker's all-interfaces default.
      portBindings[key] = [{ HostIp: hostIp || DEFAULT_EXTRA_PORT_HOST_IP, HostPort: hostPort }];
    }
  }
  return { exposedPorts, portBindings };
}

/**
 * Build the Docker build-context tar stream OURSELVES, mirroring dockerode's own
 * `prepareBuildContext` (tar-fs pack → gzip) but with an `'error'` handler
 * dockerode never attaches.
 *
 * When you pass `{ context, src }`, dockerode builds this pack internally and
 * pipes it into the request with NO error listener (its lib/util.js). tar-fs
 * walks the tree readdir → lstat; if a file listed by readdir is gone by its
 * lstat — an antivirus/editor/temp-cleaner racing the walk, or (the #448 repro)
 * our own premature context cleanup — the Pack emits an `'error'`, and because
 * `pipe()` does not forward source errors it is unhandled and takes down the
 * ENTIRE API process. Owning the pack lets us capture that, abort the in-flight
 * build request so it can't hang on a truncated body, and fail only the deploy.
 *
 * Passing the resulting STREAM (not `{ context }`) to buildImage routes through
 * dockerode's pass-through branch, so the bytes on the wire are identical to
 * what it would have produced.
 */
export function packBuildContext(
  contextDir: string,
  entries: string[],
  cancelSignal?: AbortSignal,
  ignoreContextPath?: (relativePosixPath: string) => boolean,
): { body: NodeJS.ReadableStream; abortSignal: AbortSignal; takeError: () => Error | null } {
  const controller = new AbortController();
  // tar-fs hands the predicate an absolute path; `.dockerignore` matches
  // context-relative ones. Only set when the tree was NOT pruned destructively
  // (per-service build contexts) — see ResolvedDockerfile.ignoreContextPath.
  const ignore = ignoreContextPath
    ? (absolutePath: string) =>
        ignoreContextPath(relative(contextDir, absolutePath).split(sep).join("/"))
    : undefined;
  const pack = tarFs.pack(contextDir, { entries, ignore });
  const body = pack.pipe(createGzip());
  let contextError: Error | null = null;
  const capture = (err: unknown) => {
    contextError ??= err instanceof Error ? err : new Error(String(err));
    if (!controller.signal.aborted) controller.abort();
  };
  // A cancelled build has to abort the in-flight buildImage request too: dockerode
  // forwards `abortSignal` to it, and on this path there is no remote process to
  // kill — aborting the request is the only thing that stops the daemon's build.
  if (cancelSignal) {
    if (cancelSignal.aborted) controller.abort();
    else cancelSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  // pipe() does NOT forward source errors, so a tar-fs walk failure is only
  // observable on the pack itself — this listener is what keeps it from killing
  // the process. Guard the gzip side too for completeness.
  pack.once("error", capture);
  body.once("error", capture);
  return { body, abortSignal: controller.signal, takeError: () => contextError };
}

const DURATION_UNITS_NS: Record<string, number> = {
  ns: 1,
  us: 1_000,
  µs: 1_000,
  ms: 1_000_000,
  s: 1_000_000_000,
  m: 60_000_000_000,
  h: 3_600_000_000_000,
};

/**
 * Parse a compose/Go duration ("30s", "1m30s", "500ms") to nanoseconds — the
 * unit Docker's Engine API expects for Healthcheck timings. A bare number is
 * treated as seconds (lenient; compose long-form usually carries units, but
 * bare ints appear in the wild). Returns undefined when nothing parses, so the
 * caller omits the field and Docker keeps its default.
 */
function parseDurationNs(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const str = String(value).trim();
  if (!str) return undefined;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1_000_000_000);
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    matched = true;
    total += parseFloat(m[1]!) * DURATION_UNITS_NS[m[2]!]!;
  }
  return matched ? Math.round(total) : undefined;
}

/**
 * Convert a parsed compose healthcheck into a Docker Engine Healthcheck object.
 * `test` string → `["CMD-SHELL", cmd]`; `test` array → `["CMD", ...argv]`;
 * `disable` → `["NONE"]` (turns off an image's baked-in check). Returns
 * undefined when there's nothing to configure so the image default stands.
 *
 * App catalog and migration payloads can preserve the original Docker
 * `CMD` / `CMD-SHELL` / `NONE` prefix in the `test` array, so an array that
 * already starts with one of those is honored as written instead of having an
 * extra `CMD` prepended — which is what `docker compose` does with the same
 * list, and what the engine needs to run the check at all.
 */
export function toDockerHealthcheck(
  hc?: ComposeHealthcheck,
):
  | { Test: string[]; Interval?: number; Timeout?: number; Retries?: number; StartPeriod?: number }
  | undefined {
  if (!hc) return undefined;
  if (hc.disable) return { Test: ["NONE"] };

  let Test: string[] | undefined;
  if (typeof hc.test === "string" && hc.test.trim()) {
    Test = ["CMD-SHELL", hc.test];
  } else if (Array.isArray(hc.test) && hc.test.length > 0) {
    const head = hc.test[0];
    // `["NONE"]` is compose's other way to say `disable` — prepending `CMD` to it
    // asks the engine to exec a binary named NONE, so the container the author
    // wanted UNchecked reports unhealthy forever.
    if (head === "NONE") return { Test: ["NONE"] };
    Test = head === "CMD" || head === "CMD-SHELL" ? [...hc.test] : ["CMD", ...hc.test];
  }
  if (!Test) return undefined;

  const Interval = parseDurationNs(hc.interval);
  const Timeout = parseDurationNs(hc.timeout);
  const StartPeriod = parseDurationNs(hc.startPeriod);
  return {
    Test,
    ...(Interval !== undefined && { Interval }),
    ...(Timeout !== undefined && { Timeout }),
    ...(typeof hc.retries === "number" && { Retries: hc.retries }),
    ...(StartPeriod !== undefined && { StartPeriod }),
  };
}

/**
 * Map compose `stop_signal` / `stop_grace_period` (carried on `advanced`) to the
 * container's top-level `StopSignal` / `StopTimeout` (#388). `StopTimeout` is
 * whole seconds while a compose grace period is a duration ("30s", "1m"): parse
 * to ns and round. A graceful shutdown never wants LESS time than asked, so a
 * positive sub-second grace clamps up to one second rather than truncating to
 * "kill now"; an explicit zero stays zero. Returns an empty object when neither
 * is set so the spread adds no keys and Docker keeps its defaults (SIGTERM/10s).
 */
export function toStopConfig(advanced?: ComposeAdvanced): {
  StopSignal?: string;
  StopTimeout?: number;
} {
  const out: { StopSignal?: string; StopTimeout?: number } = {};
  const signal = advanced?.stopSignal?.trim();
  if (signal) out.StopSignal = signal;
  const graceNs = parseDurationNs(advanced?.stopGracePeriod);
  if (graceNs !== undefined) {
    out.StopTimeout = graceNs <= 0 ? 0 : Math.max(1, Math.round(graceNs / 1_000_000_000));
  }
  return out;
}

/**
 * Before a container is force-removed during recreate/teardown, give one that
 * opted into a shutdown grace period the chance to flush (#388). Setting a
 * container's `StopTimeout`/`StopSignal` (from compose stop_grace_period /
 * stop_signal) does nothing unless something issues a *graceful* stop —
 * `remove({force:true})` SIGKILLs. So on the recreate + destroy paths we first
 * inspect the container: only when it carries a positive `StopTimeout` (the
 * operator asked for grace) do we `stop()` it — no explicit timeout, so Docker
 * honors that StopTimeout and StopSignal. Containers that declared no grace
 * (StopTimeout null/0, the default) skip straight to the caller's force-remove,
 * so redeploy latency is unchanged for everyone who didn't opt in. Best-effort:
 * a gone / un-inspectable / already-stopped container is fine — the caller's
 * remove handles it. The Engine API returns StopTimeout on Config even though
 * @types/dockerode omits it.
 */
export async function gracefulStopForGrace(container: Dockerode.Container): Promise<void> {
  let stopTimeout: number | null | undefined;
  try {
    // @types/dockerode omits StopTimeout from Config; the Engine API returns it.
    stopTimeout = ((await container.inspect()).Config as { StopTimeout?: number | null })
      .StopTimeout;
  } catch {
    return; // can't inspect (gone / racing removal) → let the force-remove no-op handle it
  }
  if (typeof stopTimeout === "number" && stopTimeout > 0) {
    await container.stop().catch(() => {
      /* already stopped (304) / removed (404) */
    });
  }
}

/**
 * Detect whether a buffer chunk starts with Docker's 8-byte multiplexed
 * stream header (stream_type | 0 | 0 | 0 | size_be32).
 */
function hasDockerFrameHeader(buf: Buffer, offset = 0): boolean {
  return (
    buf.length >= offset + 8 &&
    (buf[offset] === 1 || buf[offset] === 2) &&
    buf[offset + 1] === 0 &&
    buf[offset + 2] === 0 &&
    buf[offset + 3] === 0
  );
}

/**
 * Split a COMPLETE Docker multiplexed buffer into its frames, keeping which
 * stream each one came from (1 = stdout, 2 = stderr).
 *
 * Parsing the whole buffer at once (rather than per chunk) is what makes this
 * correct when a frame straddles a chunk boundary. A buffer that isn't framed at
 * all — Tty:true output, or a daemon that didn't multiplex — yields a single
 * stdout frame, so callers can run it unconditionally.
 */
export function splitDockerFrames(buf: Buffer): Array<{ stdout: boolean; data: Buffer }> {
  const frames: Array<{ stdout: boolean; data: Buffer }> = [];
  let offset = 0;
  while (offset < buf.length) {
    if (hasDockerFrameHeader(buf, offset)) {
      const size = buf.readUInt32BE(offset + 4);
      frames.push({
        stdout: buf[offset] !== 2,
        data: buf.subarray(offset + 8, offset + 8 + size),
      });
      offset += 8 + size;
    } else {
      frames.push({ stdout: true, data: buf.subarray(offset) });
      break;
    }
  }
  return frames;
}

/** Strip Docker multiplexed frame headers from a complete log buffer. */
function stripDockerHeaders(buf: Buffer): string {
  return splitDockerFrames(buf)
    .map((f) => f.data.toString("utf-8"))
    .join("");
}

/** Strip a single Docker frame header from one streaming chunk. */
function stripDockerChunkHeader(chunk: Buffer): Buffer {
  return hasDockerFrameHeader(chunk) ? chunk.subarray(8) : chunk;
}

/** Parse a Docker timestamp-prefixed log line into timestamp + message. */
function parseTimestampedLine(line: string): { timestamp: string; message: string } {
  const spaceIdx = line.indexOf(" ");
  return {
    timestamp: spaceIdx > 0 ? line.slice(0, spaceIdx) : new Date().toISOString(),
    message: spaceIdx > 0 ? line.slice(spaceIdx + 1) : line,
  };
}

/** Extract first host port and first container IP from an inspected container */
/** First non-empty IPAddress across a container's networks — the `docker ps`
 *  list view carries the same network map as inspect, so both paths agree. */
function firstNetworkIp(networks: unknown): string | undefined {
  for (const net of Object.values((networks ?? {}) as Record<string, { IPAddress?: string }>)) {
    if (net?.IPAddress) return net.IPAddress;
  }
  return undefined;
}

function extractNetworkInfo(data: { NetworkSettings?: any; HostConfig?: any }): {
  ip?: string;
  hostPort?: number;
  hostPortByContainerPort?: Record<number, number>;
} {
  let ip: string | undefined;
  for (const net of Object.values(data.NetworkSettings?.Networks ?? {}) as any[]) {
    if (net.IPAddress) {
      ip = net.IPAddress;
      break;
    }
  }
  // Keyed by CONTAINER port, because that is what a caller choosing a proxy target
  // actually knows. The scalar below is the first binding, kept for the callers that
  // only persist one number (`service_deployment.host_port`) — it is arbitrary for a
  // multi-port container, and reading it for a SPECIFIC port is how a route ends up
  // dialing a different app.
  const hostPortByContainerPort: Record<number, number> = {};
  let hostPort: number | undefined;
  const liveBindings = (data.NetworkSettings?.Ports ?? {}) as Record<
    string,
    Array<{ HostIp?: string; HostPort?: string }> | null
  >;
  const configuredBindings = (data.HostConfig?.PortBindings ?? {}) as Record<
    string,
    Array<{ HostIp?: string; HostPort?: string }> | null
  >;
  // Docker clears NetworkSettings.Ports when a container stops, while retaining
  // the publish declaration in HostConfig.PortBindings. Read the live table when
  // it has a concrete binding and otherwise fall back per key to HostConfig. A
  // stopped app must keep every routed reservation; losing these mappings is what
  // allows its old vhost port to be handed to another project.
  for (const key of new Set([...Object.keys(liveBindings), ...Object.keys(configuredBindings)])) {
    const [containerRaw, protocol = "tcp"] = key.split("/");
    if (protocol.toLowerCase() !== "tcp") continue;
    const containerPort = Number(containerRaw);
    if (!Number.isSafeInteger(containerPort) || containerPort < 1 || containerPort > 65_535) {
      continue;
    }
    const live = liveBindings[key];
    const bindings =
      live && live.some((binding) => binding?.HostPort) ? live : configuredBindings[key];
    const candidates = (bindings ?? [])
      .map((binding, index) => {
        const port = Number(binding?.HostPort);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
        const ip = binding?.HostIp?.trim().replace(/^\[|\]$/g, "") ?? "";
        // A container can retain the operator's public publish AND Openship's
        // loopback publish for one container port. Routes dial the loopback one,
        // so Docker array order must not decide which reservation we recover.
        const priority =
          ip === "127.0.0.1" || ip === "::1"
            ? 3
            : /^127(?:\.\d{1,3}){3}$/.test(ip)
              ? 2
              : ip && ip !== "0.0.0.0" && ip !== "::"
                ? 1
                : 0;
        return { index, port, priority };
      })
      .filter((candidate): candidate is { index: number; port: number; priority: number } =>
        Boolean(candidate),
      )
      .sort((left, right) => right.priority - left.priority || left.index - right.index);
    const selected = candidates[0]?.port;
    if (selected !== undefined) {
      hostPortByContainerPort[containerPort] = selected;
      hostPort ??= selected;
    }
  }
  return {
    ip,
    hostPort,
    ...(Object.keys(hostPortByContainerPort).length ? { hostPortByContainerPort } : {}),
  };
}

/**
 * Parse the reference `docker load` printed. It emits either
 * "Loaded image: <repo:tag>" (the tar carried RepoTags) or "Loaded image ID:
 * sha256:<configId>" (a save-by-id tar is untagged). Returns the last such ref
 * — that's the loadable handle on THIS daemon (the config id, not the source's
 * possibly-a-RepoDigest id), which the caller retags.
 */
function parseLoadedImageRef(output: string): string | undefined {
  const matches = [...(output || "").matchAll(/Loaded image(?: ID)?:\s*(\S+)/gi)];
  return matches.length ? matches[matches.length - 1][1].trim() : undefined;
}

/**
 * Deadline for OPENING the event stream — never for the stream itself.
 *
 * `timeout: 0` below removes docker-modem's inactivity timeout, which a long-lived
 * stream must not have, and with it the only bound on the request that opens one. A
 * half-open SSH bridge accepts the connection and answers nothing, so without this
 * the `getEvents` promise never settles: the caller's connect attempt is wedged for
 * the life of the process, holding a bridge, never reconnecting, and — since it is an
 * accelerator — failing silently.
 */
const EVENT_CONNECT_TIMEOUT_MS = 20_000;

/** Container actions we ask the daemon for; `health_status` arrives suffixed. */
const CONTAINER_EVENT_ACTIONS = [
  "die",
  "oom",
  "kill",
  "stop",
  "restart",
  "start",
  "destroy",
  "health_status",
] as const;

/**
 * One line of Docker's `/events` NDJSON → a normalized event, or `null` when the
 * line carries nothing a consumer acts on: an action we never asked for, a
 * `health_status` that is neither `healthy` nor `unhealthy` (`starting` is the
 * grace period the healthcheck author asked for), or a malformed frame. Returning
 * null rather than throwing is deliberate — one garbage line must not kill a
 * long-lived subscription.
 *
 * BOTH healthcheck edges are kept. `unhealthy` is the fault; `healthy` is the
 * recovery, and it is the only signal that one happened — a container whose
 * healthcheck starts passing again never stopped, so no `start` event follows it.
 * Dropping it left recovery from an unhealthy incident on the 60s poll while the
 * fault itself was detected in seconds.
 *
 * Pure, so the wire format is testable without a daemon.
 */
export function parseContainerEventLine(line: string): ContainerLifecycleEvent | null {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    // Valid JSON that isn't an object — `null` most of all, which is truthy-checked
    // into a property read below and would throw inside the stream's data handler,
    // taking the whole subscription down with it.
    if (!parsed || typeof parsed !== "object") return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const actor = raw.Actor as { ID?: unknown } | undefined;
  const containerId =
    typeof actor?.ID === "string" && actor.ID
      ? actor.ID
      : typeof raw.id === "string" && raw.id
        ? raw.id
        : "";
  if (!containerId) return null;

  // Modern daemons send `Action`; pre-1.22 payloads send `status`.
  const rawAction = (
    typeof raw.Action === "string" ? raw.Action : typeof raw.status === "string" ? raw.status : ""
  ).trim();
  if (!rawAction) return null;

  let action: ContainerLifecycleEvent["action"];
  if (rawAction.startsWith("health_status")) {
    // "health_status: unhealthy" — the colon-suffixed form is the only shape.
    const status = rawAction.split(":")[1]?.trim();
    if (status !== "unhealthy" && status !== "healthy") return null;
    action = status;
  } else if ((CONTAINER_EVENT_ACTIONS as readonly string[]).includes(rawAction)) {
    action = rawAction as ContainerLifecycleEvent["action"];
  } else {
    return null;
  }

  const timeNano = typeof raw.timeNano === "number" ? raw.timeNano : null;
  const atSeconds =
    typeof raw.time === "number"
      ? raw.time
      : timeNano !== null
        ? Math.floor(timeNano / 1e9)
        : Math.floor(Date.now() / 1000);

  return { containerId, action, atSeconds };
}

// ─── Docker runtime ──────────────────────────────────────────────────────────

export class DockerRuntime implements RuntimeAdapter {
  readonly name = "docker";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set<RuntimeCapability>([
    "build",
    "prebuiltImage",
    "deploy",
    "multiServiceDeploy",
    "stop",
    "start",
    "restart",
    "destroy",
    "containerInfo",
    "runtimeLogs",
    "streamLogs",
    "usage",
    "containerIp",
    "rollback",
    "serviceShell",
    "projectContainerSweep",
    "deploymentContainerQuery",
    "hostContainerQuery",
    "stabilityProbe",
    "containerEvents",
    // Docker implements `inContainerExecutor` but had never DECLARED the capability.
    // Nothing gated on it (every caller tested for the method), so the omission was
    // invisible — but it meant the honest answer to supports("inContainerExec") was
    // wrong for the one runtime that best supports it.
    "inContainerExec",
    // A docker exec lands in the container's own namespaces, so a command run
    // through it cannot reach the host. Bare deliberately does NOT declare this.
    "isolatedExec",
  ]);

  /** Docker honors every extended compose key we currently support. */
  readonly unsupportedComposeKeys: ReadonlySet<keyof ComposeAdvanced> = new Set();

  private _docker!: Dockerode;
  /** Underlying dockerode instance - exposed for advanced usage */
  get docker(): Dockerode {
    return this._docker;
  }
  /** Connection config this runtime was created with */
  readonly connectionOptions?: DockerConnectionOptions;
  /** Resolved transport - single switch point for socket / ssh / tcp */
  readonly transport: DockerTransport;
  private readonly systemManager: DockerSystemManager | null;
  private readonly provisionLock?: ProvisionLock;
  private constructor(
    opts?: DockerConnectionOptions,
    systemManager?: DockerSystemManager | null,
    provisionLock?: ProvisionLock,
  ) {
    this.connectionOptions = opts;
    this.transport = resolveDockerTransport(opts);
    this.systemManager = systemManager ?? null;
    this.provisionLock = provisionLock;
  }

  /**
   * Build a runtime and stand up its transport. Async because the SSH
   * transport binds a loopback bridge whose port is only known after listen();
   * socket/TCP transports resolve their options synchronously.
   */
  static async create(
    opts?: DockerConnectionOptions,
    systemManager?: DockerSystemManager | null,
    provisionLock?: ProvisionLock,
  ): Promise<DockerRuntime> {
    const runtime = new DockerRuntime(opts, systemManager, provisionLock);
    runtime._docker = new Dockerode(await runtime.transport.establish());
    // dockerode opens BuildKit's reverse h2c session through `node:http`; Bun
    // rejects Docker's 101 response as UnrequestedUpgrade (#745). Keep
    // dockerode's gRPC session implementation, but carry that one upgrade over
    // the raw daemon connection just like service exec/attach already do.
    if ((process.versions as NodeJS.ProcessVersions & { bun?: string }).bun) {
      installDockerodeBuildKitSessionWorkaround(runtime._docker);
    }
    return runtime;
  }

  supports(cap: RuntimeCapability): boolean {
    return this.capabilities.has(cap);
  }

  async dispose(): Promise<void> {
    // Tear down the SSH transport's loopback bridge (no-op for socket/TCP).
    await this.transport.close();
  }

  // ─── Health check ──────────────────────────────────────────────────

  /** Ping the Docker daemon - useful for connection testing */
  async ping(): Promise<boolean> {
    try {
      await this.assertReachable();
      return true;
    } catch (err) {
      // Collapsed to a boolean for liveness callers — but LOG the detailed
      // reason so it isn't lost. Paths that must show the user WHY it failed
      // should call assertReachable() and surface the thrown message instead.
      console.warn(`[docker] daemon unreachable: ${safeErrorMessage(err)}`);
      return false;
    }
  }

  /**
   * Assert the Docker daemon is reachable, RETHROWING the underlying error
   * instead of collapsing it to false. For the SSH transport, `preflight()`
   * decides the upstream transport (SSH socket forwarding where it works, else
   * `docker system dial-stdio` over an exec channel — the streamlocal-free path
   * the Bun-compiled desktop needs), then `ping()` is the real end-to-end check
   * over that transport. Use on user-facing paths (e.g. the migration scan) so
   * the real cause reaches the user instead of a generic "not reachable".
   */
  async assertReachable(): Promise<void> {
    await this.ensureDockerFeature();
    await this.transport.preflight();
    await this.docker.ping();
  }

  private async ensureDockerFeature(logger?: BuildLogger): Promise<void> {
    if (!this.systemManager) {
      return;
    }

    await this.systemManager.ensureFeature("deploy", (entry) => {
      logger?.log(entry.message, entry.level);
    });
  }

  /** Get Docker daemon info (version, platform, etc.) */
  async info(): Promise<Record<string, unknown>> {
    return this.docker.info();
  }

  // ── Image naming ────────────────────────────────────────────────────────

  /** Canonical image tag for a build session. */
  private imageTag(slug: string | undefined, sessionId: string): string {
    const name = slug ? `openship/${slug}` : `openship/build`;
    return `${name}:${sessionId}`;
  }

  /** Labels applied to both build images and deploy containers. */
  private labels(config: {
    deploymentId?: string;
    projectId: string;
    sessionId?: string;
    service?: string;
  }) {
    const l: Record<string, string> = {
      [OPENSHIP_LABEL.project]: config.projectId,
    };
    if (config.deploymentId) l[OPENSHIP_LABEL.deployment] = config.deploymentId;
    if (config.sessionId) l[OPENSHIP_LABEL.build] = config.sessionId;
    // Present on single-app containers that joined the project network; lets the
    // label-scoped reconcileNetworkMembership re-alias them after an out-of-band
    // network rebuild, exactly like a compose service.
    if (config.service) l[OPENSHIP_LABEL.service] = config.service;
    return l;
  }

  // ── Build lifecycle ────────────────────────────────────────────────────

  /**
   * Sum the byte size of a directory tree. Best-effort - used only for a
   * human-readable "X MB context streamed" log line. Returns 0 if the
   * walk hits an error rather than failing the build.
   */
  private async estimateContextSize(dir: string): Promise<number> {
    const { stat, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let total = 0;
    const stack: string[] = [dir];
    while (stack.length) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          try {
            const s = await stat(full);
            total += s.size;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return total;
  }

  private emitDockerStep(
    logger: BuildLogger,
    step: "clone" | "install" | "build",
    status: "running" | "completed" | "skipped",
    message: string,
  ): void {
    // Mirror the step event to the terminal so users can follow the
    // phases in the build log too - otherwise the terminal stays blank
    // between text logs while the stepper bar quietly advances.
    const label = status === "running" ? "→" : status === "completed" ? "✓" : "↷";
    logger.log(`[${step}] ${label} ${message}`);
    logger.step(step, status, message);
  }

  private handleBuildEvent(
    event: {
      stream?: string;
      error?: string;
      errorDetail?: { message?: string };
      status?: string;
      id?: string;
      progress?: string;
      aux?: unknown;
    },
    logger: BuildLogger,
    trace?: BuildKitTraceDecoder,
  ): string | null {
    const errorMessage = event.errorDetail?.message ?? event.error;
    if (errorMessage) {
      logger.log(errorMessage, "error");
      return errorMessage;
    }

    // A BuildKit build emits its whole progress stream as protobuf traces instead of
    // `stream` lines, so without this the log would be empty until the final error.
    // The classic builder's `aux` is an OBJECT ({"ID":"sha256:…"}), which is why the
    // string check matters — it is not decoration.
    if (event.id === "moby.buildkit.trace" && typeof event.aux === "string") {
      let hint: string | null = null;
      for (const line of trace?.push(event.aux) ?? []) {
        // Same treatment the classic builder's `stream` lines get, deliberately: the
        // failure hints (OOM-killed install, wrong rootDirectory, BuildKit refused)
        // are the only thing that turns a bare exit code into an explanation, and
        // BuildKit builds are precisely the ones with no other diagnostic.
        logger.log(line.message, line.level === "error" ? "error" : parseLogLevel(line.message));
        hint ??= this.extractBuildFailureHint(line.message);
      }
      return hint;
    }

    if (event.stream) {
      const line = event.stream.trim();
      if (!line) return null;

      const marker = line.match(
        /^\[openship-build\]\s+step=(clone|install|build)\s+status=(running|completed|skipped)$/,
      );
      if (marker) {
        const [, step, status] = marker;
        this.emitDockerStep(
          logger,
          step as "clone" | "install" | "build",
          status as "running" | "completed" | "skipped",
          line,
        );

        // After install completes inside the RUN, Docker still needs to
        // commit layers, run the runtime stage (COPY, etc.), and tag the
        // image. Tell the user we're past the slow part - the rest is
        // fast and not progress-streamed.
        if (status === "completed" && step === "install") {
          logger.log("Finalizing image (layer commit + tag)...");
        }

        return null;
      }

      if (this.isLowSignalDockerLine(line)) {
        return null;
      }

      logger.log(line, parseLogLevel(line));
      return this.extractBuildFailureHint(line);
    }

    if (event.status) {
      const parts = [event.id, event.status, event.progress]
        .filter((p): p is string => Boolean(p?.trim()))
        .map((p) => p.trim());
      if (parts.length) logger.log(parts.join(" "));
    }

    return null;
  }

  // Only the truly-redundant lines get filtered. We KEEP "Step N/M : ..."
  // because that's the user's best progress signal during a long build -
  // it shows which Dockerfile instruction is currently executing.
  //
  // Removed (= now passes through to terminal):
  //   - "Step N/M : ..."  → high-signal, shows progress
  //   - "Successfully built / tagged" → confirms success
  //
  // Still filtered (= noise):
  //   - "---> hash"       → opaque layer hash, no signal for users
  //   - "Running in ..."  → intermediate container id, no signal
  //   - "Removing intermediate container ..." → cleanup chatter
  private static readonly DOCKER_BUILDER_NOISE: RegExp[] = [
    /^--->/i, // ---> abc123def
    /^Running in\s+[a-f0-9]{6,}$/i,
    /^Removing intermediate container\s+[a-f0-9]{6,}$/i,
  ];

  private isLowSignalDockerLine(line: string): boolean {
    return DockerRuntime.DOCKER_BUILDER_NOISE.some((p) => p.test(line));
  }

  private extractBuildFailureHint(line: string): string | null {
    if (/returned a non-zero code:\s*\d+/i.test(line)) {
      return line;
    }

    // The legacy builder's own wording for "this Dockerfile needs BuildKit". Reached
    // when the syntax sniff missed a construct, or on a remote host whose docker CLI
    // has no buildx plugin — either way the raw message says nothing about what to
    // do, and #634 lost a reporter to exactly that.
    if (/requires? BuildKit|BuildKit is enabled but the buildx component/i.test(line)) {
      return `${line} — this Dockerfile needs BuildKit. Install the docker buildx plugin on the build host (\`docker-buildx-plugin\`), or remove the BuildKit-only instruction.`;
    }

    // The other side of the same coin: this build asked the daemon for BuildKit and
    // the daemon said no (BuildKit disabled in daemon.json, or an engine older than
    // 18.09). Without this the user gets a bare daemon string for a build the classic
    // builder would also have failed, and no way to tell the two apart.
    if (
      /buildkit (is )?(not (supported|enabled)|disabled)|builder version.*not supported/i.test(line)
    ) {
      return `${line} — this Dockerfile needs BuildKit but this Docker daemon has it disabled. Enable it ("features": {"buildkit": true} in daemon.json) or remove the BuildKit-only instruction.`;
    }

    if (/\/workspace\/package\.json/i.test(line) && /ENOENT/i.test(line)) {
      return "Docker build ran from /workspace but package.json was not found there. The configured rootDirectory is likely empty or incorrect.";
    }

    if (/failed to solve|executor failed running|error: build/i.test(line)) {
      return line;
    }

    return null;
  }

  private formatDockerConnectivityError(error: unknown): string {
    const message = safeErrorMessage(error);

    if (/^Cannot reach Docker daemon:/i.test(message)) {
      return message;
    }

    return `Cannot reach Docker daemon: ${message}. ${this.transport.unreachableHint}`;
  }

  /**
   * SSH transport build path. Bypasses dockerode's HTTP-over-SSH upload
   * (which is ~1-2 MB/s and silent) in favor of two well-trodden pieces:
   *
   *   1. `transferLocalDirectory(...)` - defaults to rsync over the
   *      SYSTEM `ssh` binary (NOT the Node `ssh2` library), with native
   *      `--progress` output streamed straight from rsync. ~10-30 MB/s
   *      typical. Lands the context at `/tmp/openship-build-<sessionId>`
   *      on remote. Falls back to tar through the ssh2 channel only if
   *      rsync isn't installed on either side.
   *
   *   2. `executor.streamExec("docker build ...")` - runs native docker
   *      CLI on the remote. Its raw stdout/stderr streams back unfiltered
   *      so the user sees real "Step N/M : ...", layer hashes, install
   *      output, etc. Same logs you'd see SSHing in and running it by hand.
   *
   * Container lifecycle (deploy, stop, logs, etc.) still uses dockerode -
   * only the slow build upload moves to this path.
   */
  /**
   * Ship a prepared context dir to the remote host (rsync via system ssh with
   * native --progress; tar/ssh2 fallback). Reused by both the single-image SSH
   * build and the batch build (which transfers the shared context ONCE).
   */
  private async transferBuildContext(
    contextDir: string,
    remoteContextDir: string,
    log: BuildLogger,
  ): Promise<void> {
    const executor = this.connectionOptions?.executor;
    if (!executor) throw new Error("SSH build path requires an executor on connectionOptions");

    log.log(`Streaming build context to ${remoteContextDir}...`);
    // Wipe stale dir from a previous failed deploy, if any. -rf is safe - the
    // path is namespaced and only ever holds the context we just transferred.
    await executor.exec(`rm -rf ${sq(remoteContextDir)} && mkdir -p ${sq(remoteContextDir)}`);
    // `contextDir` is ALREADY the prepared source tree (prepareSourceTree applied
    // git-truth / cloned the tracked set and stripped `.git`). Transfer it
    // VERBATIM — pass `excludes: []` so the transfer doesn't re-apply the
    // name-based default and delete tracked source (e.g. an `app/.../build`
    // route) that the prepare step deliberately kept.
    //
    // The whole tree ships even when a build narrows its context to a subdirectory:
    // one batch shares one transfer across services whose contexts differ, and the
    // narrowing is applied as the `docker build` cwd on the host. `.dockerignore`
    // for a narrowed context is then applied by the docker CLI itself, from the file
    // that actually sits in that context.
    //
    // Accepted cost: a batch with a narrowed context skips the destructive prune, so
    // tracked-but-dockerignored bulk reaches this host temp dir (removed after the
    // build) where it previously did not. Pruning "everything outside every context"
    // would restore it, but only for batches where NO service builds from the root —
    // and it cannot affect image CONTENT, since docker can never reach outside a
    // context and the dockerode packer applies each context's own file.
    await transferLocalDirectory(
      contextDir,
      { kind: "executor", executor, path: remoteContextDir },
      log,
      { excludes: [] },
    );
  }

  /**
   * Is BuildKit usable on the remote host? Probed, never assumed: a plain `docker`
   * CLI without the buildx plugin HARD-FAILS when BuildKit is requested explicitly
   * ("BuildKit is enabled but the buildx component is missing or broken"), while an
   * unadorned `docker build` on the same box falls back to the legacy builder and
   * works — the same trap {@link buildImage} in system/managed-image.ts documents.
   * So we ask first, and only then opt in.
   *
   * Memoized per adapter instance (one instance ≈ one target daemon), so a compose
   * batch pays a single `docker buildx version` for N images.
   */
  private buildKitProbe: Promise<boolean> | null = null;

  private async remoteBuildKitAvailable(): Promise<boolean> {
    const executor = this.connectionOptions?.executor;
    if (!executor) return false;

    const probe = (this.buildKitProbe ??= executor
      // A SENTINEL, not a pattern match on the version banner: a false positive here
      // is FATAL (BuildKit requested without buildx hard-errors), so the answer has
      // to come from the exit code and nothing else. A login shell that prints a
      // banner, or a `docker` wrapper's help text, must not read as "buildx".
      // `|| true` keeps a missing plugin off the error path — docker exits non-zero
      // for an unknown subcommand and an SshExecutor rejects on that.
      .exec("docker buildx version >/dev/null 2>&1 && echo OPENSHIP_BUILDKIT_OK || true")
      .then((out) => out.split(/\r?\n/).some((line) => line.trim() === "OPENSHIP_BUILDKIT_OK"))
      .catch(() => false));

    const available = await probe;
    // Only a POSITIVE answer is memoized. A transient SSH failure that answered
    // "false" must not pin every later build on this adapter to the legacy builder —
    // that is the probe-memo-poison shape this repo has been bitten by before.
    if (!available) this.buildKitProbe = null;
    return available;
  }

  /**
   * Run native `docker build` on the remote host against an already-transferred
   * context dir. One image; `dockerfileName` selects which Dockerfile to use (so N
   * services can build from one transferred tree) and is relative to
   * `remoteBuildDir` — the build CONTEXT, which for a compose service is its own
   * `build:` directory inside that tree, not the tree root (#634).
   */
  private async buildImageOnRemote(
    config: BuildConfig,
    remoteBuildDir: string,
    dockerfileName: string,
    tag: string,
    log: BuildLogger,
    opts?: { signal?: AbortSignal; requiresBuildKit?: boolean },
  ): Promise<void> {
    const signal = opts?.signal;
    const executor = this.connectionOptions?.executor;
    if (!executor) throw new Error("SSH build path requires an executor on connectionOptions");

    // Compose the docker build command. Quoting matters - buildargs and labels
    // can contain `=` and spaces.
    const resolvedBuildArgs = resolveDockerBuildArgs(config);
    const buildArgs = Object.entries(resolvedBuildArgs)
      .map(([k, v]) => `--build-arg ${sq(`${k}=${v}`)}`)
      .join(" ");
    const labelArgs = Object.entries(
      this.labels({ projectId: config.projectId, sessionId: config.sessionId }),
    )
      .map(([k, v]) => `--label ${sq(`${k}=${v}`)}`)
      .join(" ");
    const dockerfileFlag =
      dockerfileName && dockerfileName !== "Dockerfile" ? ` -f ${sq(dockerfileName)}` : "";

    // BuildKit when the box actually has it: `RUN --mount=type=cache`, heredocs and
    // the rest of the modern Dockerfile syntax only work under it, and the legacy
    // builder fails those with a bare "the --mount option requires BuildKit".
    // `--force-rm` is a legacy-builder concept (BuildKit keeps no intermediate
    // containers to remove), so it goes when BuildKit is on.
    const buildKit = await this.remoteBuildKitAvailable();
    const builderEnv = buildKit ? "DOCKER_BUILDKIT=1 " : "";
    // `--progress` is a buildx flag, NOT a docker-build flag: a CLI without the
    // plugin rejects it outright with `unknown flag: --progress` and exit 125, before
    // it ever looks at the context. `--force-rm` is the mirror image — a legacy-only
    // concept (BuildKit keeps no intermediate containers to remove). So the flag set
    // follows the builder; passing either unconditionally breaks one of the two.
    const builderFlags = buildKit ? " --progress=plain" : " --force-rm";
    if (buildKit) {
      log.log("Builder: BuildKit (docker buildx detected on the host)");
    } else if (opts?.requiresBuildKit) {
      // Said BEFORE the build rather than after it fails: the legacy builder's own
      // error names a flag, not a fix. Not fatal — the syntax sniff is a heuristic,
      // and refusing to build on it would be worse than letting docker decide.
      log.log(
        "This Dockerfile needs BuildKit, but the build host's docker CLI has no buildx plugin. Install it (`docker-buildx-plugin`, or Docker's official packages) — the build below will use the legacy builder and is likely to fail.",
        "warn",
      );
    } else {
      log.log(
        "Builder: legacy (docker buildx not available on the host) — BuildKit-only Dockerfile syntax such as `RUN --mount` will not work",
      );
    }

    // `cd` into the CONTEXT dir FIRST so docker resolves `-f` and the context
    // `.` from the same place (BuildKit otherwise resolves `-f` against the SSH
    // user's home, not the context).
    // --progress=plain: over a non-TTY SSH pipe BuildKit's compact auto-progress
    // prints terse "#N 0.xx" lines and DROPS the failed step's actual stdout/stderr
    // (an OOM-killed `bun install`, a tsup error, …), so a failed build surfaced only
    // as a bare "exited with code 1". Plain progress streams every line through.
    const buildCmd =
      `cd ${sq(remoteBuildDir)} && ` +
      `${builderEnv}docker build${builderFlags} -t ${sq(tag)}${dockerfileFlag} ` +
      `${labelArgs} ${buildArgs} .`;

    log.log(
      `Running Docker build on remote (${Object.keys(resolvedBuildArgs).length} build argument${Object.keys(resolvedBuildArgs).length === 1 ? "" : "s"}; values hidden).`,
    );
    log.log("─── docker build output ───");
    this.emitDockerStep(
      log,
      "install",
      "running",
      "Running install inside container (docker build)",
    );

    const { code } = await executor.streamExec(
      buildCmd,
      (entry) => {
        // Pass docker's real output straight through.
        log.log(entry.message, parseLogLevel(entry.message));
      },
      { signal },
    );

    log.log("─── end docker build output ───");
    // SshExecutor intentionally resolves an aborted stream so browser log
    // teardown is not reported as a transport failure. A deployment cancel is
    // different: surface it as a cancelled BuildResult instead of continuing
    // through image verification and deploy.
    if (signal?.aborted) throw new BuildCancelledError();
    if (code !== 0) throw new Error(`docker build exited with code ${code}`);
    this.emitDockerStep(log, "install", "completed", "Image build finished");
  }

  /**
   * Clone the repo directly ON the remote host into `remoteContextDir` — the
   * clone-on-server alternative to transferBuildContext (which clones on the
   * orchestrator and rsyncs the tree). Runs `git clone` in a remote host shell,
   * mirroring the bare runtime (build-pipeline.ts): the credential-helper relay
   * (`config.gitCredentialHelperPath` — plain URL, nothing persisted) when set,
   * else `injectGitToken(...)`. Strips `.git` so it never ships into the image.
   */
  private async cloneSourceOnRemote(
    config: BuildConfig,
    remoteContextDir: string,
    log: BuildLogger,
  ): Promise<void> {
    const executor = this.connectionOptions?.executor;
    if (!executor) throw new Error("Clone-on-server requires an SSH executor on connectionOptions");

    const useHelper = !!config.gitCredentialHelperPath;

    // Prefer a direct GitHub tarball download on the server (no git, no history,
    // no context transfer) when we can authenticate without the relay. HTTPS-
    // only — skipped for the relay AND for SSH key auth. Ambient auth is also
    // skipped: the credential lives in the host's git config, which curl can't
    // consult, so a private repo would 404 (a public one succeeds via the clone
    // path just as cheaply). Falls through to git clone on ANY failure.
    if (!useHelper && !config.gitSsh && !config.gitAmbient) {
      const ref = config.commitSha || config.branch;
      const tarUrl = githubTarballUrl(config.repoUrl, ref);
      if (tarUrl) {
        try {
          log.log(`Fetching ${config.repoUrl} tarball on the server → ${remoteContextDir}...\n`);
          await downloadTarballOnRemote(executor, {
            url: tarUrl,
            token: config.gitToken,
            destDir: remoteContextDir,
            onLog: (entry) => log.log(entry.message, parseLogLevel(entry.message)),
          });
          // A tarball has no .git, but strip defensively in case a repo tracks one.
          await executor.exec(`rm -rf ${sq(`${remoteContextDir}/.git`)}`).catch(() => {});
          return;
        } catch (err) {
          log.log(
            `Tarball download failed (${safeErrorMessage(err)}); falling back to git clone.\n`,
            "warn",
          );
        }
      }
    }

    // SSH mode (per-server key / deploy key): write the 0600 key + known_hosts
    // on the remote out of band (executor.writeFile — never echoed) and clone
    // over git@github.com. Cleaned up in the finally below.
    let sshMaterial: GitSshMaterial | undefined;
    if (config.gitSsh) {
      sshMaterial = await materializeGitSsh(
        shellGitSshWriter({
          exec: (cmd) => executor.exec(cmd),
          writeSecret: (path, content) => executor.writeFile(path, content),
        }),
        `${remoteContextDir}.gitssh`,
        config.gitSsh,
      );
    }

    // Centralized clone assembly (token / relay / ssh / ambient) — see git-clone.ts.
    const {
      cloneUrl,
      gitEnv: GIT_ENV,
      credFlag: CRED,
    } = assembleGitClone({
      repoUrl: config.repoUrl,
      gitToken: config.gitToken,
      gitCredentialHelperPath: config.gitCredentialHelperPath,
      ssh: sshMaterial,
      ambient: config.gitAmbient,
    });
    const dir = sq(remoteContextDir);

    const authLabel = config.gitSsh
      ? "ssh key"
      : useHelper
        ? "forwarded credentials"
        : config.gitAmbient
          ? `the server's own git credentials (${config.gitAmbient.via})`
          : "token";
    log.log(`Cloning ${config.repoUrl} on the server → ${remoteContextDir} (${authLabel})...\n`);
    await executor.exec(`rm -rf ${dir} && mkdir -p ${dir}`);

    const run = async (cmd: string) => {
      const { code } = await executor.streamExec(cmd, (entry) =>
        log.log(entry.message, parseLogLevel(entry.message)),
      );
      if (code !== 0) throw new Error(`git clone on server exited with code ${code}`);
    };

    try {
      if (config.commitSha) {
        try {
          await run(
            `${GIT_ENV} git ${CRED} clone --progress --depth 50 --branch ${sq(config.branch)} ${sq(cloneUrl)} ${dir} && ` +
              `cd ${dir} && git ${CRED} -c advice.detachedHead=false checkout ${sq(config.commitSha)}`,
          );
        } catch {
          log.log(
            `Commit ${config.commitSha} not in the shallow clone; unshallowing and retrying.\n`,
            "warn",
          );
          await run(
            `cd ${dir} && ${GIT_ENV} git ${CRED} fetch --progress --unshallow && ` +
              `git ${CRED} -c advice.detachedHead=false checkout ${sq(config.commitSha)}`,
          );
        }
      } else {
        await run(
          `${GIT_ENV} git ${CRED} clone --progress --depth 1 --branch ${sq(config.branch)} ${sq(cloneUrl)} ${dir}`,
        );
      }
      // Never ship .git into the build image.
      await executor.exec(`rm -rf ${sq(`${remoteContextDir}/.git`)}`).catch(() => {});
    } finally {
      await sshMaterial?.cleanup();
    }
  }

  /**
   * Resolve the Dockerfile for a build whose source lives on the REMOTE host
   * (clone-on-server). Mirrors resolveServiceDockerfile but probes the remote
   * tree with `test -f` instead of the local FS: a repository Dockerfile
   * candidate is used when present; otherwise a Dockerfile is generated locally
   * (pure fn) and written to the remote tree.
   *
   * Returns the build CONTEXT dir on the host plus the Dockerfile path relative to
   * it — the same pair {@link resolveServiceDockerfile} produces locally, because
   * these two resolvers are one behaviour with two probes and a narrowed context
   * learned by only one of them would leave #634 reproducible on this target.
   */
  private async resolveRemoteDockerfile(
    config: BuildConfig,
    remoteContextDir: string,
    generatedName: string,
    requireRepositoryDockerfile: boolean,
    log?: BuildLogger,
  ): Promise<{ remoteBuildDir: string; dockerfileName: string }> {
    const executor = this.connectionOptions?.executor;
    if (!executor) throw new Error("Clone-on-server requires an SSH executor on connectionOptions");

    const contextSubdir = dockerBuildContextDirectory(config);
    const remoteBuildDir = contextSubdir
      ? `${remoteContextDir}/${contextSubdir}`
      : remoteContextDir;

    if (contextSubdir) {
      // The lexical `..` refusal happens in normalizeDockerRelativePath; this closes
      // the symlink hole the same way the local resolver does, since `cd`-ing into a
      // tracked `svc -> /etc` would hand host files to the build. `pwd -P` is the
      // shell's own realpath, so one exec answers "exists AND stays inside".
      const real = await executor
        .exec(`cd ${sq(remoteBuildDir)} 2>/dev/null && pwd -P || true`)
        .then((out) => out.trim())
        .catch(() => "");
      const root = await executor
        .exec(`cd ${sq(remoteContextDir)} && pwd -P`)
        .then((out) => out.trim())
        .catch(() => "");
      if (!real) {
        throw new Error(
          `Build context "${contextSubdir}" is not a directory in the cloned source. Check the service's build path.`,
        );
      }
      if (!root || (real !== root && !real.startsWith(`${root}/`))) {
        throw new Error(`Build context "${contextSubdir}" resolves outside the cloned source.`);
      }
    }

    const candidates = contextSubdir
      ? resolveContextDockerfileCandidates(contextSubdir, config.dockerfilePath)
      : resolveDockerfileCandidates(config.rootDirectory, config.dockerfilePath);

    for (const candidate of candidates) {
      const out = await executor
        .exec(`test -f ${sq(`${remoteBuildDir}/${candidate}`)} && echo yes || true`)
        .catch(() => "");
      if (out.trim() === "yes") {
        // Same non-silent fallback the local resolver makes: the context's plain
        // `Dockerfile` is the LAST candidate, so landing on it after an explicit
        // `dockerfile` was configured means we are building something other than what
        // was asked for. Warned in both resolvers or the two diverge on diagnostics.
        const explicit = normalizeDockerRelativePath(config.dockerfilePath);
        if (
          contextSubdir &&
          explicit &&
          candidate === "Dockerfile" &&
          explicit !== "Dockerfile" &&
          explicit !== `${contextSubdir}/Dockerfile`
        ) {
          log?.log(
            `Configured Dockerfile "${config.dockerfilePath}" was not found in build context "${contextSubdir}" — using ${contextSubdir}/Dockerfile instead.`,
            "warn",
          );
        }
        return { remoteBuildDir, dockerfileName: candidate };
      }
    }

    // A generated recipe COPYs from the source root, so a narrowed context can
    // never satisfy it — refuse instead of writing a Dockerfile doomed to fail.
    if (contextSubdir) {
      throw new Error(
        missingContextDockerfileMessage(contextSubdir, config.dockerfilePath, {
          generatedRecipeRefused: !requireRepositoryDockerfile,
        }),
      );
    }

    if (requireRepositoryDockerfile) {
      const expected = config.dockerfilePath?.trim() || "Dockerfile";
      throw new Error(
        `No Dockerfile found in the cloned repo. Expected ${expected}${config.rootDirectory ? ` under ${config.rootDirectory}` : ""}.`,
      );
    }

    // Generate one locally (pure function of config) and ship just the file.
    await executor.writeFile(`${remoteContextDir}/${generatedName}`, generateDockerfile(config));
    return { remoteBuildDir, dockerfileName: generatedName };
  }

  private async buildViaSshTarPipe(
    config: BuildConfig,
    buildContext: Awaited<ReturnType<typeof createDockerBuildContext>>,
    tag: string,
    log: BuildLogger,
    signal?: AbortSignal,
  ): Promise<void> {
    const remoteContextDir = `/tmp/openship-build-${config.sessionId}`;
    try {
      // The whole TREE is transferred (a narrowed context still needs its siblings
      // present for a compose batch); only the `docker build` cwd narrows.
      await this.transferBuildContext(buildContext.contextDir, remoteContextDir, log);
      await this.buildImageOnRemote(
        config,
        buildContext.contextSubdir
          ? `${remoteContextDir}/${buildContext.contextSubdir}`
          : remoteContextDir,
        buildContext.dockerfileName,
        tag,
        log,
        { signal, requiresBuildKit: buildContext.requiresBuildKit },
      );
    } finally {
      // Always clean up the remote context - even on failure. Don't await - if
      // cleanup fails we still want the build result.
      this.connectionOptions?.executor?.exec(`rm -rf ${sq(remoteContextDir)}`).catch(() => {
        /* best effort */
      });
      await buildContext.cleanup();
    }
  }

  /**
   * Pick the Engine-API builder for ONE dockerode build, for BOTH dockerode call
   * sites (single image and compose batch) — they are the same decision and a
   * builder learned by only one of them is the "two executors" trap all over again.
   *
   * The classic builder is kept as the DEFAULT deliberately. It is what every
   * self-hosted local build has always used; switching wholesale would change layer
   * caching for everyone and silently drop the build CPU/memory caps, which BuildKit
   * ignores. So BuildKit is opted into only where the classic builder cannot work at
   * all — a Dockerfile whose syntax it rejects (#634).
   *
   * Through the ENGINE API (`version=2`), not by shelling out to `docker build`,
   * which is the first alternative that comes to mind and is not available: the API
   * image ships `openssh-client rsync git` and no docker CLI (apps/api/Dockerfile),
   * and the transport may be a TCP socket with no shell at the other end at all.
   * Nothing needs the buildx plugin either — BuildKit lives in the daemon.
   *
   * Asymmetric with the remote CLI path on purpose: there, BuildKit is taken whenever
   * buildx exists, because that command passes no --memory/--cpus (so there is no cap
   * to lose) and on docker ≥23 the CLI already defaults to it — the prefix mostly
   * buys the log line and the buildx-missing warning.
   */
  private selectDockerodeBuilder(
    config: BuildConfig,
    requiresBuildKit: boolean,
    log: BuildLogger,
  ): { options: { version?: "2" }; trace?: BuildKitTraceDecoder } {
    if (!requiresBuildKit) return { options: {} };

    log.log(
      "Dockerfile uses BuildKit-only syntax (RUN --mount, a syntax directive or a heredoc) — building with BuildKit.",
    );
    if (Object.keys(dockerBuildResourceLimits(config.resources)).length > 0) {
      log.log(
        "Build CPU/memory limits are not enforced under BuildKit — this build runs uncapped.",
        "warn",
      );
    }

    return { options: { version: "2" }, trace: new BuildKitTraceDecoder() };
  }

  /**
   * Dockerode build path. Used for local socket and TCP transports, plus
   * SSH transports that didn't get an executor wired in (shouldn't happen
   * in normal operation but kept as a safety net).
   *
   * This path is slower for SSH (HTTP-over-SSH upload has no streaming),
   * but it's correct for local/TCP where there's no separate SSH
   * connection to piggyback on.
   */
  private async buildViaDockerode(
    config: BuildConfig,
    buildContext: Awaited<ReturnType<typeof createDockerBuildContext>>,
    tag: string,
    log: BuildLogger,
    cancelSignal?: AbortSignal,
  ): Promise<void> {
    log.log(`Streaming build context to Docker daemon - image tag: ${tag}`);

    const { body, abortSignal, takeError } = packBuildContext(
      buildContext.buildContextDir,
      buildContext.contextEntries,
      cancelSignal,
      buildContext.ignoreContextPath,
    );

    const builder = this.selectDockerodeBuilder(config, buildContext.requiresBuildKit, log);

    try {
      const stream = await this.docker.buildImage(body, {
        t: tag,
        dockerfile: buildContext.dockerfileName,
        labels: this.labels({ projectId: config.projectId, sessionId: config.sessionId }),
        buildargs: resolveDockerBuildArgs(config),
        // Omitted entirely unless the project set a build cap — a self-hosted
        // build should be free to use the machine (a production build often
        // needs several GB). Opt-in only; see dockerBuildResourceLimits.
        ...dockerBuildResourceLimits(config.resources),
        forcerm: true,
        ...builder.options,
        abortSignal,
      });

      log.log("Connected to Docker daemon. Build output follows:");
      await this.streamDockerodeBuild(stream, log, builder.trace);
      log.log("Docker daemon finished streaming build output. Finalizing image...\n");
    } catch (err) {
      // A context-pack failure aborts the request, so the rejection here is the
      // abort, not the real cause — prefer the captured pack error.
      const contextErr = takeError();
      throw contextErr
        ? new Error(`Failed to read Docker build context: ${safeErrorMessage(contextErr)}`, {
            cause: contextErr,
          })
        : err;
    } finally {
      // Clean up only AFTER the daemon has fully consumed the context. dockerode's
      // buildImage promise resolves as soon as the response starts, while tar-fs
      // may still be walking contextDir — deleting it here (the old `finally`
      // around buildImage alone) is exactly what raced the pack in #448.
      await buildContext.cleanup();
    }
  }

  /**
   * Consume a dockerode build stream: stream progress to the log, enforce the
   * idle timeout + keepalive, and throw on a fatal build event. Shared by the
   * single-image dockerode path and the local batch build (buildImages).
   */
  private async streamDockerodeBuild(
    stream: NodeJS.ReadableStream,
    log: BuildLogger,
    trace?: BuildKitTraceDecoder,
  ): Promise<void> {
    let fatalBuildError: string | null = null;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let idleTimer: NodeJS.Timeout | null = null;
      let keepaliveTimer: NodeJS.Timeout | null = null;
      let idleMinutes = 0;

      const clearTimers = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        idleMinutes = 0;
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        (stream as any).destroy?.(error);
        reject(error);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve();
      };

      const resetIdleTimer = () => {
        clearTimers();
        keepaliveTimer = setInterval(() => {
          idleMinutes += 1;
          log.log(`Still building... (no output for ${idleMinutes}m)`);
        }, 60_000);
        if ((keepaliveTimer as any).unref) (keepaliveTimer as any).unref();

        idleTimer = setTimeout(() => {
          fail(
            new Error(
              "Docker build produced no output for 30 minutes. This usually means the remote server cannot reach the package registry, has broken DNS, or the Docker daemon stalled during the build.",
            ),
          );
        }, DOCKER_BUILD_IDLE_TIMEOUT_MS);
        if ((idleTimer as any).unref) (idleTimer as any).unref();
      };

      resetIdleTimer();

      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) {
            fail(err);
            return;
          }
          succeed();
        },
        (event) => {
          resetIdleTimer();
          fatalBuildError ??= this.handleBuildEvent(event, log, trace);
        },
      );
    });

    if (fatalBuildError) {
      throw new Error(fatalBuildError);
    }
  }

  /**
   * Confirm a just-built image actually exists before handing its tag back
   * as the deploy artifact.
   *
   * For SSH-transport builds, verify over the SAME pooled SSH exec channel
   * the `docker build` command itself just ran on — not `this.docker`
   * (dockerode), which for SSH transport talks over a SEPARATE, independently
   * -tunneled streamlocal bridge connection (see docker-ssh-agent.ts). That
   * second connection has proven unreliable in practice: it can hang
   * indefinitely or report the image missing even though `docker images` on
   * the box confirms it built successfully seconds earlier. Reusing the
   * already-proven-live exec channel avoids standing up a second, flakier
   * connection just to ask a question the first connection already knows
   * the answer to.
   *
   * For local-socket/TCP transports there is no separate bridge — `this.docker`
   * talks directly to the daemon — so the original dockerode check is fine
   * and stays as the fallback.
   */
  private async verifyImageBuilt(tag: string): Promise<void> {
    const executor = this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;
    try {
      if (executor) {
        await executor.exec(`docker image inspect ${sq(tag)} >/dev/null`);
      } else {
        await this.docker.getImage(tag).inspect();
      }
    } catch (cause) {
      throw new Error(`Docker build finished but the image ${tag} was not created`, { cause });
    }
  }

  async build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult> {
    const log = logger ?? new BuildLogger();
    const startTime = Date.now();
    const tag = this.imageTag(config.slug, config.sessionId);
    const abort = registerDockerBuild(config.sessionId);
    const cancelled = (): BuildResult => {
      log.step("build", "failed", "Docker build cancelled");
      return {
        sessionId: config.sessionId,
        status: "cancelled",
        durationMs: Date.now() - startTime,
      };
    };

    try {
      if (abort.signal.aborted) return cancelled();
      log.log(`Build strategy: docker (${this.transport.description})\n`);

      // Ensure the host is provisioned for Docker, but avoid doing a second
      // SSH bridge handshake before the real build request. The build call
      // itself is the connectivity check and saves one full round-trip.
      try {
        await this.ensureDockerFeature(log);
      } catch (featureErr) {
        throw new Error(this.formatDockerConnectivityError(featureErr));
      }

      const sshExecutor = this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;

      // ── Clone-on-server path ───────────────────────────────────────────
      // Clone the repo ON the remote host and build there — no local clone and
      // no context transfer. Only for SSH server builds that opted in.
      if (sshExecutor && config.cloneOnServer) {
        const remoteContextDir = `/tmp/openship-build-${config.sessionId}`;
        try {
          this.emitDockerStep(log, "clone", "running", "Cloning source on the server...");
          await this.cloneSourceOnRemote(config, remoteContextDir, log);
          if (abort.signal.aborted) throw new BuildCancelledError();
          this.emitDockerStep(log, "clone", "completed", "Source cloned on the server");
          const { remoteBuildDir, dockerfileName } = await this.resolveRemoteDockerfile(
            config,
            remoteContextDir,
            "Dockerfile.openship",
            config.stack === "docker",
            log,
          );
          await this.buildImageOnRemote(config, remoteBuildDir, dockerfileName, tag, log, {
            signal: abort.signal,
          });
        } finally {
          sshExecutor.exec(`rm -rf ${sq(remoteContextDir)}`).catch(() => {
            /* best effort */
          });
        }

        // Same last gate as the transferred-context path below: a cancel that lands
        // after the build command finished must not hand back a deployable image.
        if (abort.signal.aborted) return cancelled();
        await this.verifyImageBuilt(tag);
        log.log(`Image ${tag} is ready.\n`);
        log.step("build", "completed", `Finalizing image ${tag}`);
        return {
          sessionId: config.sessionId,
          status: "deploying",
          imageRef: tag,
          durationMs: Date.now() - startTime,
        };
      }

      this.emitDockerStep(log, "clone", "running", "Preparing Docker build context...");

      const buildContext = await createDockerBuildContext(config, {
        requireRepositoryDockerfile: config.stack === "docker",
        onLog: log.callback,
      });
      if (abort.signal.aborted) throw new BuildCancelledError();

      // Report the size of the context so users know what they're paying
      // for over the SSH wire. Failure here is non-fatal - the build can
      // still proceed if we couldn't `du`.
      try {
        const sizeBytes = await this.estimateContextSize(buildContext.contextDir);
        const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
        this.emitDockerStep(log, "clone", "completed", `Docker build context ready (${sizeMB} MB)`);
      } catch {
        this.emitDockerStep(log, "clone", "completed", "Docker build context ready");
      }

      if (buildContext.contextSubdir) {
        // #634: when the context was the clone root but the Dockerfile lived under a
        // subdir, nothing in the log said so — and a failing COPY looked like a
        // missing file. Name the context whenever it is not the source root.
        log.log(`Using Docker build context: ${buildContext.contextSubdir}`);
      } else if (buildContext.rootDirectory) {
        log.log(`Using Docker build root: ${buildContext.rootDirectory}`);
      }

      if (buildContext.usesRepositoryDockerfile) {
        this.emitDockerStep(
          log,
          "install",
          "skipped",
          "Repository Dockerfile owns dependency installation",
        );
        this.emitDockerStep(
          log,
          "build",
          "running",
          "Building image from repository Dockerfile...",
        );
      }

      if (!buildContext.usesRepositoryDockerfile && !config.installCommand) {
        this.emitDockerStep(log, "install", "skipped", "No install command configured");
      }
      if (!buildContext.usesRepositoryDockerfile && !config.buildCommand) {
        this.emitDockerStep(log, "build", "skipped", "No build command configured");
      }

      if (sshExecutor) {
        // ── Fast SSH path ──────────────────────────────────────────────
        // Bypass dockerode for the upload - it tars and POSTs the context
        // as one HTTP body through SSH-tunneled-HTTP, which is ~1-2 MB/s.
        // Instead: use the same tar-over-SSH pipe bare deploys use (with
        // per-3s `~X% · Y MB sent · Z MB/s` progress), then run native
        // `docker build` on the remote so its real stdout/stderr streams
        // back uninterpreted.
        await this.buildViaSshTarPipe(config, buildContext, tag, log, abort.signal);
      } else {
        // ── Dockerode path (local socket, TCP, or SSH without executor) ─
        await this.buildViaDockerode(config, buildContext, tag, log, abort.signal);
      }

      // Last gate before the image counts as deployable. Cancelling mid-build is
      // best-effort on every path — an abort that lands after the daemon finished
      // still leaves a usable image here — so without this check a cancel would
      // return "deploying", and the pipeline (which stops ONLY on "cancelled" and
      // re-writes the row to "deploying" without checking for a terminal state)
      // would deploy the deployment the user just cancelled.
      if (abort.signal.aborted) return cancelled();

      await this.verifyImageBuilt(tag);

      log.log(`Image ${tag} is ready.\n`);
      log.log(`[build] ✓ Image ${tag} ready`);
      log.step("build", "completed", `Finalizing image ${tag}`);
      const durationMs = Date.now() - startTime;
      return { sessionId: config.sessionId, status: "deploying", imageRef: tag, durationMs };
    } catch (err) {
      if (abort.signal.aborted || err instanceof BuildCancelledError) return cancelled();
      const msg = safeErrorMessage(err);
      log.step("build", "failed", `Docker build failed: ${msg}`);
      return {
        sessionId: config.sessionId,
        status: "failed",
        durationMs: Date.now() - startTime,
        errorMessage: `Docker build failed: ${msg}`,
      };
    } finally {
      releaseDockerBuild(config.sessionId, abort);
    }
  }

  /**
   * Acquire a registry image without ever treating it as a Dockerfile builder.
   *
   * The returned digest is preferred over the requested tag so a later deploy
   * runs exactly the bytes acquired here even if a mutable tag moves between
   * prepare and deploy. The image is deliberately non-owned: it came from a
   * registry and may be shared by unrelated containers on the target daemon, so
   * deployment cleanup must never remove it as if Openship had built it.
   */
  async prepareImage(config: ImageArtifactConfig, logger?: BuildLogger): Promise<BuildResult> {
    const log = logger ?? new BuildLogger();
    const startTime = Date.now();
    const abort = registerDockerBuild(config.sessionId);
    const cancelled = (): BuildResult => {
      log.step("build", "failed", "Image pull cancelled");
      return {
        sessionId: config.sessionId,
        status: "cancelled",
        durationMs: Date.now() - startTime,
        artifactOwned: false,
      };
    };

    try {
      if (abort.signal.aborted) return cancelled();

      const requestedRef = config.imageRef.trim();
      if (!requestedRef) throw new Error("Prebuilt image reference is required");

      log.step("build", "running", `Pulling prebuilt image ${requestedRef}`);
      try {
        await this.ensureDockerFeature(log);
      } catch (featureErr) {
        throw new Error(this.formatDockerConnectivityError(featureErr));
      }
      await this.pullImage(requestedRef, { force: config.forcePull });

      // A pull cannot currently be interrupted through every Docker transport,
      // but cancellation must still prevent the acquired image from deploying.
      if (abort.signal.aborted) return cancelled();

      const deployRef =
        (await this.resolveImageDigest(requestedRef).catch(() => undefined)) ?? requestedRef;
      log.log(
        deployRef === requestedRef
          ? `Image ${requestedRef} is ready.\n`
          : `Image ${requestedRef} is ready as ${deployRef}.\n`,
      );
      log.step("build", "completed", `Prebuilt image ${deployRef} is ready`);
      return {
        sessionId: config.sessionId,
        status: "deploying",
        imageRef: deployRef,
        durationMs: Date.now() - startTime,
        artifactOwned: false,
      };
    } catch (err) {
      if (abort.signal.aborted) return cancelled();
      const message = safeErrorMessage(err);
      log.step("build", "failed", `Image pull failed: ${message}`);
      return {
        sessionId: config.sessionId,
        status: "failed",
        durationMs: Date.now() - startTime,
        errorMessage: `Image pull failed: ${message}`,
        artifactOwned: false,
      };
    } finally {
      releaseDockerBuild(config.sessionId, abort);
    }
  }

  /**
   * Move an extract-only static build's files out of its builder image onto
   * `hostOutDir`, then delete the image.
   *
   * The ONE place this happens, shared by the single-app path
   * ({@link buildStaticToHost}) and the compose batch path ({@link buildImages}) —
   * they used to be destined to diverge, and the source path is subtle enough
   * (see `staticBuilderOutputPath`) that two copies would drift into extracting an
   * empty directory.
   */
  private async moveStaticBuildToHost(
    tag: string,
    config: BuildConfig,
    hostOutDir: string,
    log: BuildLogger,
  ): Promise<void> {
    // The builder's own output dir, resolved by the SAME helper the recipe used, so
    // the extractor can never read a different path than the build wrote.
    const docRoot = staticBuilderOutputPath(config);
    const sshExecutor = this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;
    // Name the path: when extraction fails, "which directory was it reading" is the
    // first question, and it's the one thing the old failure never said.
    log.log(`Moving built files out of the build container (${docRoot})...\n`);
    try {
      if (sshExecutor) {
        await this.extractDocRootOverSsh(sshExecutor, tag, docRoot, hostOutDir);
      } else {
        // A local daemon shares our disk, so let it copy in place. It reports back
        // false when it can't — VM-backed daemon, or a builder image with no shell —
        // and that's also the remote-daemon case, where the archive has to come over
        // the wire.
        const copiedInPlace =
          this.transport.kind === "socket" &&
          (await this.extractDocRootViaBindMount(tag, docRoot, hostOutDir));
        if (!copiedInPlace) {
          await this.extractDocRootViaDaemon(tag, docRoot, hostOutDir);
        }
      }
      await this.pruneBuildFilesFromDocRoot(config, hostOutDir, sshExecutor ?? null, log);
      log.log(`Static files ready at ${hostOutDir}\n`);
    } finally {
      // Files are on the host now; the builder image is dead weight. Best-effort —
      // a lingering image is harmless, a failed deploy over it is not.
      await this.removeImage(tag).catch(() => {
        /* best effort */
      });
    }
  }

  /**
   * Build a STATIC app in a Docker sandbox, then move the built files onto a host
   * directory the edge serves via nginx `root`. Reuses `build()` so Docker is
   * auto-ensured (ensureDockerFeature).
   *
   * NO RUNTIME IMAGE. `staticExtractOnly` stops the recipe at the builder stage and
   * the files are copied straight out of it. This used to build a full
   * `nginx:alpine` runtime stage — pulling that image, running six more steps, and
   * writing an nginx config nothing reads — only to `docker cp` the doc-root out
   * and delete the whole thing moments later. The edge already serves these files;
   * a second web server was never going to run.
   * Returns the host dir as `imageRef`, matching BareRuntime.build's host-dir
   * contract so the existing file-backed serve path (deployStatic /
   * resolveStaticRoot) consumes it unchanged. Never leaves a long-lived container:
   * the extraction container runs one `cp` (or isn't started at all, when the tar is
   * streamed instead) and is removed either way.
   */
  async buildStaticToHost(
    config: BuildConfig,
    hostOutDir: string,
    logger?: BuildLogger,
  ): Promise<BuildResult> {
    const log = logger ?? new BuildLogger();
    const buildResult = await this.build(
      { ...config, isStatic: true, staticExtractOnly: true },
      log,
    );
    // Failure / cancel bubbles up unchanged — the pipeline's existing status
    // checks handle it.
    if (buildResult.status !== "deploying" || !buildResult.imageRef) {
      return buildResult;
    }

    const tag = buildResult.imageRef;
    const extractStart = Date.now();
    // `build()` released its controller before returning, so nothing was watching
    // the extract — a `docker create` + `docker cp` of the whole output tree, long
    // enough to cancel through. Re-register to stay cancellable across it;
    // registerDockerBuild pre-aborts from the pending map, so a cancel that landed
    // inside that gap is not lost.
    const abort = registerDockerBuild(config.sessionId);
    // The caller sees ONE build, so the reported duration covers image + extract.
    const elapsed = () => (buildResult.durationMs ?? 0) + (Date.now() - extractStart);
    const cancelled = (): BuildResult => {
      log.step("build", "failed", "Static extract cancelled");
      return { sessionId: config.sessionId, status: "cancelled", durationMs: elapsed() };
    };
    try {
      await this.moveStaticBuildToHost(tag, config, hostOutDir, log);
      if (abort.signal.aborted) return cancelled();
      return {
        sessionId: config.sessionId,
        status: "deploying",
        imageRef: hostOutDir,
        durationMs: elapsed(),
      };
    } catch (err) {
      // cancelBuild force-removes containers carrying this build's label, which is
      // how the extract container dies mid-`cp`. That throw is the cancel, not a
      // static-build failure.
      if (abort.signal.aborted || err instanceof BuildCancelledError) return cancelled();
      const msg = safeErrorMessage(err);
      log.step("build", "failed", `Static extract failed: ${msg}`);
      return {
        sessionId: config.sessionId,
        status: "failed",
        durationMs: elapsed(),
        errorMessage: `Static extract failed: ${msg}`,
      };
    } finally {
      releaseDockerBuild(config.sessionId, abort);
    }
  }

  /**
   * THE CONTRACT all three extractors satisfy: once one returns, `hostOutDir` holds
   * the doc-root's CONTENTS directly — `index.html` at the top, no wrapping
   * directory. OpenResty's `root` points straight at it, so one stray level is a
   * silent 404 for the whole site.
   *
   * They reach that shape differently, which is why the rule is stated here once
   * instead of in each branch:
   *   - `docker cp <cid>:<root>/.` and `cp -a <root>/. <out>/` — the trailing `/.`
   *     means "contents of", so there is nothing to strip.
   *   - `getArchive({path: <root>})` — the tar is rooted at the doc-root's own
   *     basename (`dist/`, `build/`, …), so exactly one leading component is
   *     stripped.
   *
   * The other half of the contract is that hostOutDir is non-EMPTY, which is what
   * this enforces. It has to be checked per-path (three different filesystems) but
   * the rule and its wording live here, because the failure it prevents is the
   * expensive one: every extractor can succeed having copied nothing, which deploys
   * green and then 404s the entire site.
   */
  /**
   * Names that must never end up in a public doc-root, matched at its TOP LEVEL
   * only.
   *
   * `.git` is the repository — serving it publishes full source history. The
   * Dockerfiles and `.dockerignore` are OUR build inputs, and one of them is
   * literally written into the tree by `resolveServiceDockerfile`.
   */
  private static readonly DOC_ROOT_EXCLUDED = [
    ".dockerignore",
    ".git",
    "Dockerfile",
    "Dockerfile.*",
  ];

  /**
   * Remove build inputs from an extracted static doc-root, then re-assert the
   * contract that it still holds something servable.
   *
   * Only runs when the doc-root IS the build context — `outputDirectory` empty or
   * "." — which is the zero-build "just files, index.html at the root" project. A
   * real output directory (`dist`, `build`) is written by the build and contains
   * none of this, so the prune is a no-op there.
   *
   * Two distinct problems, one fix. The build context is pruned by `.dockerignore`
   * and THEN the generated recipe is written into it, so for these projects the
   * published site contained `.dockerignore` + `Dockerfile.openship…` — and any
   * tracked `.git` — at their own public URLs. Worse, those files count as
   * content: a repo with an allowlist `.dockerignore` (`*` + `!src`) extracted to
   * a tree holding ONLY the two build files, which passed the non-empty check and
   * deployed green as a site that 404s every request. Pruning first and
   * re-checking after is what makes that check mean "there is something to serve".
   */
  private async pruneBuildFilesFromDocRoot(
    config: BuildConfig,
    hostOutDir: string,
    sshExecutor: CommandExecutor | null,
    log: BuildLogger,
  ): Promise<void> {
    if (staticBuilderOutputPath(config) !== builderContextRoot(config)) return;

    if (sshExecutor) {
      const globs = DockerRuntime.DOC_ROOT_EXCLUDED.map((name) => `${sq(hostOutDir)}/${name}`).join(
        " ",
      );
      // Unquoted globs on purpose (the DIRECTORY is quoted): `Dockerfile.*` has to
      // expand on the remote shell. A glob that matches nothing expands to itself,
      // which `rm -rf` treats as an absent path — exit 0, nothing removed.
      await sshExecutor.exec(`rm -rf ${globs}`).catch(() => {
        /* best effort */
      });
      log.log(`Excluded build files from the published output (${hostOutDir}).\n`);
      const listing = (
        await sshExecutor.exec(`ls -A ${sq(hostOutDir)} | head -1`).catch(() => "x")
      ).trim();
      this.assertDocRootServable(!listing, hostOutDir);
      return;
    }

    const { readdir, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const entries = await readdir(hostOutDir).catch(() => null);
    // Unreadable is INCONCLUSIVE, never "empty" — a probe that cannot look must not
    // fail a deploy (same rule as isEmptyDir).
    if (entries === null) return;
    const doomed = entries.filter((name) => isExcludedDocRootEntry(name));
    for (const name of doomed) {
      await rm(join(hostOutDir, name), { recursive: true, force: true }).catch(() => {});
    }
    if (doomed.length > 0) {
      log.log(`Excluded build files from the published output: ${doomed.join(", ")}\n`);
    }
    this.assertDocRootServable(entries.length === doomed.length, hostOutDir);
  }

  /** Post-prune half of the doc-root contract: build inputs are not content. */
  private assertDocRootServable(isEmpty: boolean, hostOutDir: string): void {
    if (!isEmpty) return;
    throw new Error(
      `the static output at ${hostOutDir} contains only build files (Dockerfile / ` +
        `.dockerignore) and nothing to serve — check the project's output directory ` +
        `setting and its .dockerignore.`,
    );
  }

  private assertDocRootFilled(isEmpty: boolean, docRoot: string): void {
    if (!isEmpty) return;
    throw new Error(
      `static extract produced no files from ${docRoot} in the build container — ` +
        `check the project's output directory setting.`,
    );
  }

  /** Remote host: disk-to-disk via the host's own docker CLI — never stream a
   *  large tar over the SSH dockerode bridge (same rationale as saveImage/pullImage). */
  private async extractDocRootOverSsh(
    sshExecutor: CommandExecutor,
    tag: string,
    docRoot: string,
    hostOutDir: string,
  ): Promise<void> {
    const cid = (await sshExecutor.exec(`docker create ${sq(tag)}`)).trim();
    try {
      // The PARENT, not `hostOutDir` itself: promote renames this dir into
      // releases/, and rename(2) needs write permission on the source's parent.
      // Ensuring `.builds` covers the dir it will create here too, so the leaf
      // comes out user-owned from a plain mkdir.
      await ensureOwnedDir(sshExecutor, dirOf(hostOutDir));
      await sshExecutor.exec(`mkdir -p ${sq(hostOutDir)}`);
      // `/.` → contents, so no strip step (see the contract above).
      await sshExecutor.exec(`docker cp ${sq(`${cid}:${docRoot}/.`)} ${sq(hostOutDir)}`);
      // `docker cp` of an empty dir exits 0, so the contract is checked here.
      const listing = (
        await sshExecutor.exec(`ls -A ${sq(hostOutDir)} | head -1`).catch(() => "")
      ).trim();
      this.assertDocRootFilled(!listing, docRoot);
    } finally {
      await sshExecutor.exec(`docker rm ${sq(cid)}`).catch(() => {
        /* best effort */
      });
    }
  }

  /**
   * LOCAL DAEMON: let the daemon do the copy on its own disk. The builder image is
   * run once with `hostOutDir` bind-mounted, and it `cp -a`s the doc-root across.
   * No archive crosses this process at all.
   *
   * This exists because streaming the doc-root out via `getArchive` is undebuggable
   * when it goes wrong. Once the daemon has sent 200 + headers for an archive it has
   * NO way to report a mid-archive failure — an unreadable file, a socket/fifo, a
   * path it can't stat — so it just closes the connection. The client sees a
   * truncated body and the only symptom anywhere is `tar: Unexpected EOF in
   * archive`, with the actual cause visible solely in the daemon's own log. That is
   * the failure this method removes: `cp` runs in the container, so a real error
   * arrives as real stderr and a real exit code.
   *
   * Requires that the daemon's filesystem IS this process's filesystem, which is
   * true for DooD (`/opt/openship/static` is a host bind mount at the same path
   * inside and out — see docker/docker-compose.yml) and false for a VM-backed
   * daemon (Docker Desktop, Colima), where `hostOutDir` resolves inside the VM and
   * the copy would land somewhere this process can't see.
   *
   * So it PROVES the assumption instead of trusting the transport: a sentinel file
   * is written here and the container refuses to copy unless it can see it. A
   * daemon that can't reach our disk exits 97 and the caller streams instead. That
   * check is folded into the same container run — no extra round trip — because
   * getting it wrong means an empty doc-root, i.e. a site that deploys green and
   * serves 404s.
   *
   * Returns false when the bind isn't shared; throws on a real copy failure.
   */
  private async extractDocRootViaBindMount(
    tag: string,
    docRoot: string,
    hostOutDir: string,
  ): Promise<boolean> {
    const { mkdir, readdir, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { randomBytes } = await import("node:crypto");
    await mkdir(hostOutDir, { recursive: true });
    const OUT = "/__openship_out";
    const probe = `.openship-extract-probe-${randomBytes(6).toString("hex")}`;
    await writeFile(join(hostOutDir, probe), "probe");
    const container = await this.docker.createContainer({
      Image: tag,
      // Override the ENTRYPOINT: builder base images (node, bun) ship a
      // docker-entrypoint.sh that would swallow this Cmd.
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: [
        `set -e; test -f ${sq(`${OUT}/${probe}`)} || exit 97; ` +
          `cp -a ${sq(docRoot)}/. ${OUT}/; rm -f ${sq(`${OUT}/${probe}`)}`,
      ],
      // Root, explicitly. A builder image that sets `USER node`/`USER bun` would
      // otherwise run this copy unprivileged and fail writing into a root-owned
      // output dir — the two paths this replaces both run with daemon privileges,
      // so anything less would be a NEW failure this change introduced.
      User: "0:0",
      HostConfig: {
        // `:z` matches how compose mounts this dir — required on SELinux hosts for
        // the container to write, and ignored where SELinux is off.
        Binds: [`${hostOutDir}:${OUT}:z`],
      },
    });
    try {
      // A builder image with no shell (distroless/scratch) can't run this at all.
      // That's not a reason to fail the deploy — fall back to streaming, same as an
      // unshared filesystem.
      try {
        await container.start();
      } catch {
        return false;
      }
      const status = await container.wait();
      // The daemon mounted a different filesystem than ours — not an error, just
      // not a shortcut we can take here.
      if (status.StatusCode === 97) return false;
      if (status.StatusCode !== 0) {
        const logs = await container
          .logs({ stdout: true, stderr: true, tail: 40 })
          .then((b) => Buffer.from(b as unknown as Buffer).toString("utf8"))
          // Strip the 8-byte stream framing so the operator reads text, not control
          // bytes (these logs are multiplexed — Tty is false).
          .then((s) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim())
          .catch(() => "");
        throw new Error(
          `static extract failed copying ${docRoot} out of the build container ` +
            `(exit ${status.StatusCode})${logs ? `: ${logs.slice(-500)}` : ""}`,
        );
      }
      const entries = (await readdir(hostOutDir).catch(() => [] as string[])).filter(
        (e) => e !== probe,
      );
      this.assertDocRootFilled(entries.length === 0, docRoot);
      return true;
    } finally {
      await container.remove({ force: true }).catch(() => {
        /* best effort */
      });
      // The container removes the sentinel on success; clear it on every other path
      // so it can't end up served as part of the site.
      await rm(join(hostOutDir, probe), { force: true }).catch(() => {
        /* best effort */
      });
    }
  }

  /** Remote TCP daemon: no shared filesystem and no local `docker` CLI, so the tar
   *  has to come through dockerode and be extracted onto THIS process's disk. */
  private async extractDocRootViaDaemon(
    tag: string,
    docRoot: string,
    hostOutDir: string,
  ): Promise<void> {
    const { mkdir, readdir } = await import("node:fs/promises");
    const { spawn } = await import("node:child_process");
    const { pipeline } = await import("node:stream/promises");
    await mkdir(hostOutDir, { recursive: true });
    const container = await this.docker.createContainer({ Image: tag });
    try {
      const tarStream = (await container.getArchive({ path: docRoot })) as unknown as Readable;
      // The archive is rooted at the doc-root's own basename → strip that ONE
      // component (contract above).
      const extract = spawn("tar", ["-x", "--strip-components=1", "-C", hostOutDir]);
      let errBuf = "";
      extract.stderr.on("data", (d) => (errBuf += d.toString()));
      const exited = new Promise<number>((resolve) => {
        extract.on("close", (code) => resolve(code ?? 0));
        extract.on("error", () => resolve(-1));
      });

      // `pipeline`, NOT `.pipe()`. pipe propagates neither a mid-transfer source
      // error nor the child's stdin flush, so a truncated archive surfaced only as
      // tar's own "Unexpected EOF in archive" — the actual cause discarded, and the
      // write side possibly still in flight when we resolved. pipeline awaits the
      // flush, destroys both ends on failure, and rethrows the SOURCE error.
      let streamError: unknown;
      await pipeline(tarStream, extract.stdin).catch((err) => {
        streamError = err;
      });
      const code = await exited;

      const tarErr = errBuf.trim();
      // Which half of the pipe to blame. tar's own stderr wins when it has something
      // concrete to say (a bad option, a full disk). Otherwise a transport failure is
      // the real story — reporting tar's EOF there points at the wrong half, which is
      // exactly how this failure mode stayed undiagnosable.
      if (streamError && !(code !== 0 && tarErr)) {
        throw new Error(
          `static extract failed reading ${docRoot} from the build container: ` +
            `${safeErrorMessage(streamError)}${tarErr ? ` (tar: ${tarErr.slice(-200)})` : ""}`,
        );
      }
      if (code !== 0) {
        throw new Error(`static extract failed (tar ${code}): ${tarErr.slice(-500)}`);
      }

      // An archive truncated on a block boundary makes tar exit 0 having written
      // NOTHING (contract above).
      const entries = await readdir(hostOutDir).catch(() => [] as string[]);
      this.assertDocRootFilled(entries.length === 0, docRoot);
    } finally {
      await container.remove({ force: true }).catch(() => {
        /* best effort */
      });
    }
  }

  /**
   * Batch build: clone + prune the shared source ONCE, then build every image
   * from that single tree. For SSH the context is transferred ONCE and each
   * image builds on the remote against it. Eliminates the per-service re-clone
   * / re-transfer that N separate build() calls incur — every service builds on
   * the SAME daemon, so the source only needs to arrive once.
   *
   * Prepare-phase logs (clone/transfer) go to `prepareLogger`; each image's
   * build output goes to its own `spec.logger`.
   */
  async buildImages(
    specs: Array<{
      config: BuildConfig;
      serviceName: string;
      logger: BuildLogger;
      requireRepositoryDockerfile?: boolean;
      onStart?: () => void;
      onResult?: (result: BuildResult) => void;
    }>,
    prepareLogger: BuildLogger,
  ): Promise<Array<{ serviceName: string; result: BuildResult }>> {
    if (specs.length === 0) return [];

    try {
      await this.ensureDockerFeature(prepareLogger);
    } catch (featureErr) {
      throw new Error(this.formatDockerConnectivityError(featureErr));
    }

    // Every service in a compose/monorepo build shares ONE repo+branch+commit,
    // so the first spec's source config drives the single clone.
    const source = specs[0]!.config;
    const isSsh = this.transport.kind === "ssh" && !!this.connectionOptions?.executor;
    const cloneOnServer = isSsh && !!source.cloneOnServer;
    const remoteContextDir = `/tmp/openship-build-${source.sessionId}`;

    // Register EVERY service's build up front, before the shared clone/transfer:
    // a cancel that lands during that shared phase must be seen by all of them,
    // and cancelBuild() only reaches builds that are already registered.
    const abortControllers = new Map(
      specs.map((spec) => [spec.config.sessionId, registerDockerBuild(spec.config.sessionId)]),
    );
    const isCancelled = (sessionId: string): boolean =>
      abortControllers.get(sessionId)?.signal.aborted === true;
    // `every`, not `some`: the shared phases below are shared, so they may only be
    // skipped when there is no surviving service left to need them. Today a cancel
    // covers a whole compose deploy at once (cancelCovers matches every
    // `<parent>-<serviceId>`), but `some` would silently starve the survivors of
    // their context the day per-service cancellation exists.
    const allCancelled = (): boolean =>
      [...abortControllers.values()].every((c) => c.signal.aborted);
    const cancelledResult = (sessionId: string, startedAt: number): BuildResult => ({
      sessionId,
      status: "cancelled",
      durationMs: Date.now() - startedAt,
    });

    let tree: Awaited<ReturnType<typeof prepareSourceTree>> | null = null;
    try {
      // Cancelled while these controllers were being registered. Bail BEFORE the
      // clone: it is the most expensive thing this method does on the host, and a
      // build nobody is waiting for should not pay for a full `git clone`.
      if (allCancelled()) {
        const startedAt = Date.now();
        return specs.map((spec) => {
          const result = cancelledResult(spec.config.sessionId, startedAt);
          spec.onResult?.(result);
          return { serviceName: spec.serviceName, result };
        });
      }

      // Acquire the shared source ONCE: clone-on-server clones directly on the
      // remote host (no transfer); otherwise clone on the orchestrator (and
      // transfer the tree below).
      if (cloneOnServer) {
        prepareLogger.step("clone", "running", "Cloning source on the server...");
        await this.cloneSourceOnRemote(source, remoteContextDir, prepareLogger);
        prepareLogger.step("clone", "completed", "Source cloned on the server");
      } else {
        prepareLogger.step("clone", "running", "Preparing shared build context...");
        tree = await prepareSourceTree(source, {
          onLog: prepareLogger.callback,
          // Any service building from its OWN `build:` directory makes the source
          // root's `.dockerignore` the wrong file to prune this SHARED tree with —
          // it would delete files the other contexts need. Those builds filter their
          // own context instead; see SourceTree.dockerignorePruned.
          //
          // A malformed value throws here; `true` is the safe answer for it, because
          // it only skips a destructive prune. Letting the throw out would fail the
          // WHOLE batch, while per-spec resolution below reports it against the one
          // service that owns it.
          perServiceBuildContexts: specs.some((spec) => {
            try {
              return Boolean(dockerBuildContextDirectory(spec.config));
            } catch {
              return true;
            }
          }),
        });
      }

      // Resolve/generate each service's Dockerfile INTO the shared tree, with a
      // per-service generated name so concurrent builds never clobber each other.
      const resolvedList = await Promise.all(
        specs.map(async (spec) => {
          const generatedName = `Dockerfile.openship.${spec.config.sessionId}`;
          const requireRepo = spec.requireRepositoryDockerfile ?? spec.config.stack === "docker";
          try {
            if (cloneOnServer) {
              const { remoteBuildDir, dockerfileName } = await this.resolveRemoteDockerfile(
                spec.config,
                remoteContextDir,
                generatedName,
                requireRepo,
                spec.logger,
              );
              return {
                spec,
                dockerfileName,
                remoteBuildSubdir: dockerBuildContextDirectory(spec.config),
                remoteBuildDir,
                buildContextDir: null as string | null,
                contextEntries: null as string[] | null,
                ignoreContextPath: undefined as ((path: string) => boolean) | undefined,
                // Only the dockerode branch consults it, and clone-on-server never
                // reaches that branch (it is SSH by construction).
                requiresBuildKit: false,
                error: null as string | null,
              };
            }
            const resolved = await resolveServiceDockerfile(tree!.contextDir, spec.config, {
              requireRepositoryDockerfile: requireRepo,
              generatedName,
              dockerignorePruned: tree!.dockerignorePruned,
              onLog: spec.logger.callback,
            });
            return {
              spec,
              dockerfileName: resolved.dockerfileName,
              remoteBuildSubdir: resolved.contextSubdir,
              remoteBuildDir: resolved.contextSubdir
                ? `${remoteContextDir}/${resolved.contextSubdir}`
                : remoteContextDir,
              buildContextDir: resolved.buildContextDir as string | null,
              contextEntries: resolved.contextEntries,
              ignoreContextPath: resolved.ignoreContextPath,
              requiresBuildKit: resolved.requiresBuildKit,
              error: null as string | null,
            };
          } catch (err) {
            return {
              spec,
              dockerfileName: null as string | null,
              remoteBuildSubdir: "",
              remoteBuildDir: remoteContextDir,
              buildContextDir: null as string | null,
              contextEntries: null as string[] | null,
              ignoreContextPath: undefined as ((path: string) => boolean) | undefined,
              requiresBuildKit: false,
              error: safeErrorMessage(err),
            };
          }
        }),
      );

      // Local-clone path: report context size + transfer the shared tree ONCE.
      // (clone-on-server already put the tree on the remote — nothing to transfer.)
      if (!cloneOnServer && tree) {
        try {
          const sizeBytes = await this.estimateContextSize(tree.contextDir);
          prepareLogger.step(
            "clone",
            "completed",
            `Shared build context ready (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
          );
        } catch {
          prepareLogger.step("clone", "completed", "Shared build context ready");
        }
        // Don't push megabytes at a host whose build the user already cancelled.
        if (isSsh && !allCancelled()) {
          await this.transferBuildContext(tree.contextDir, remoteContextDir, prepareLogger);
        }
      }

      // Build each image against the shared tree ONE AT A TIME. Sequential is
      // deliberate: concurrent `docker build` over SSH contends for SSH channels
      // (nondeterministic which stream wins) and for server memory (parallel
      // `bun install`/`next build` OOMs a single box). Sequential also lets each
      // service's onStart fire in turn, so the UI's auto-follow lands on the ONE
      // service that's actually streaming. The expensive part (clone + transfer)
      // is already shared above; only the per-image build is serialized here.
      const results: Array<{ serviceName: string; result: BuildResult }> = [];
      for (const {
        spec,
        dockerfileName,
        remoteBuildDir,
        remoteBuildSubdir,
        buildContextDir,
        contextEntries,
        ignoreContextPath,
        requiresBuildKit,
        error,
      } of resolvedList) {
        const startedAt = Date.now();
        const tag = this.imageTag(spec.config.slug, spec.config.sessionId);
        const signal = abortControllers.get(spec.config.sessionId)?.signal;

        // Cancelled before this service's turn came up (builds are sequential, so
        // most services of a cancelled compose deploy land here). Reported as
        // "cancelled", never "failed" — the pipeline branches on it.
        if (isCancelled(spec.config.sessionId)) {
          const result = cancelledResult(spec.config.sessionId, startedAt);
          spec.onResult?.(result);
          results.push({ serviceName: spec.serviceName, result });
          continue;
        }

        if (error || !dockerfileName) {
          const result: BuildResult = {
            sessionId: spec.config.sessionId,
            status: "failed",
            durationMs: Date.now() - startedAt,
            errorMessage: error ?? "Failed to resolve Dockerfile",
          };
          spec.onResult?.(result);
          results.push({ serviceName: spec.serviceName, result });
          continue;
        }

        // This image's build starts now — flip its status so the UI follows it.
        spec.onStart?.();

        try {
          if (remoteBuildSubdir) {
            spec.logger.log(`Using Docker build context: ${remoteBuildSubdir}\n`);
          }

          if (isSsh) {
            await this.buildImageOnRemote(
              spec.config,
              remoteBuildDir,
              dockerfileName,
              tag,
              spec.logger,
              { signal, requiresBuildKit },
            );
          } else {
            // Own the pack (error handler + abort) so a build-context read
            // failure fails just this service instead of crashing the API — see
            // packBuildContext (#448). tree.cleanup() only runs after the whole
            // loop (outer finally), so the context stays put while tar-fs walks.
            const { body, abortSignal, takeError } = packBuildContext(
              buildContextDir ?? tree!.contextDir,
              contextEntries ?? [],
              signal,
              ignoreContextPath,
            );
            const builder = this.selectDockerodeBuilder(spec.config, requiresBuildKit, spec.logger);
            try {
              const stream = await this.docker.buildImage(body, {
                t: tag,
                dockerfile: dockerfileName,
                labels: this.labels({
                  projectId: spec.config.projectId,
                  sessionId: spec.config.sessionId,
                }),
                buildargs: resolveDockerBuildArgs(spec.config),
                ...dockerBuildResourceLimits(spec.config.resources),
                forcerm: true,
                ...builder.options,
                abortSignal,
              });
              await this.streamDockerodeBuild(stream, spec.logger, builder.trace);
            } catch (err) {
              const contextErr = takeError();
              throw contextErr
                ? new Error(
                    `Failed to read Docker build context: ${safeErrorMessage(contextErr)}`,
                    { cause: contextErr },
                  )
                : err;
            }
          }

          // Same last gate as build(): an image that finished under a cancel must
          // not come back "deploying", or the compose pipeline deploys it anyway.
          if (isCancelled(spec.config.sessionId)) {
            const result = cancelledResult(spec.config.sessionId, startedAt);
            spec.onResult?.(result);
            results.push({ serviceName: spec.serviceName, result });
            continue;
          }

          await this.verifyImageBuilt(tag);

          // Extract-only static service: the edge serves these files from the host,
          // so lift them out of the builder and hand back the DIRECTORY as imageRef.
          // Done inside the batch so the shared clone/transfer is still paid once —
          // routing it through buildStaticToHost would re-clone per service.
          if (spec.config.staticExtractOnly && spec.config.staticOutDir) {
            await this.moveStaticBuildToHost(
              tag,
              spec.config,
              spec.config.staticOutDir,
              spec.logger,
            );
            // The extract is a `docker create` + `docker cp` of the whole output
            // tree over SSH — long enough to cancel through. Re-gate: the check
            // above ran before it, and a "deploying" here deploys the deployment
            // the user cancelled. The half-copied dir is per-build and unreferenced.
            const result = isCancelled(spec.config.sessionId)
              ? cancelledResult(spec.config.sessionId, startedAt)
              : {
                  sessionId: spec.config.sessionId,
                  status: "deploying" as const,
                  imageRef: spec.config.staticOutDir,
                  durationMs: Date.now() - startedAt,
                };
            spec.onResult?.(result);
            results.push({ serviceName: spec.serviceName, result });
            continue;
          }

          spec.logger.log(`Image ${tag} is ready.\n`);
          const result: BuildResult = {
            sessionId: spec.config.sessionId,
            status: "deploying",
            imageRef: tag,
            durationMs: Date.now() - startedAt,
          };
          spec.onResult?.(result);
          results.push({ serviceName: spec.serviceName, result });
        } catch (err) {
          // A cancelled build surfaces as an aborted stream or BuildCancelledError;
          // either way it is not a build failure.
          if (isCancelled(spec.config.sessionId) || err instanceof BuildCancelledError) {
            spec.logger.log("Docker build cancelled\n", "error");
            const result = cancelledResult(spec.config.sessionId, startedAt);
            spec.onResult?.(result);
            results.push({ serviceName: spec.serviceName, result });
            continue;
          }
          const msg = safeErrorMessage(err);
          spec.logger.log(`Docker build failed: ${msg}\n`, "error");
          const result: BuildResult = {
            sessionId: spec.config.sessionId,
            status: "failed",
            durationMs: Date.now() - startedAt,
            errorMessage: `Docker build failed: ${msg}`,
          };
          spec.onResult?.(result);
          results.push({ serviceName: spec.serviceName, result });
        }
      }
      return results;
    } finally {
      for (const [sessionId, abort] of abortControllers) {
        releaseDockerBuild(sessionId, abort);
      }
      if (isSsh) {
        this.connectionOptions?.executor?.exec(`rm -rf ${sq(remoteContextDir)}`).catch(() => {
          /* best effort */
        });
      }
      if (tree) await tree.cleanup();
    }
  }

  async cancelBuild(sessionId: string): Promise<void> {
    // A compose deploy registers one build per service under `<sessionId>-<serviceId>`,
    // so abort every active build this id covers, not just an exact match.
    for (const [activeId, abort] of activeDockerBuilds) {
      if (cancelCovers(sessionId, activeId)) abort.abort();
    }
    // Recorded unconditionally: "something was active" does NOT mean every build
    // this cancel covers has registered — the later services of a compose deploy
    // may still be queued behind the one that's running.
    recordPendingCancellation(sessionId);

    // Closing an SSH channel normally sends SIGHUP to its remote shell, but a
    // host-side `docker build` may outlive that channel while the daemon keeps
    // working. Kill whatever is running in this session's private context dirs,
    // sharing BareRuntime's sweep. A no-op for local/TCP runtimes and when the
    // command has already exited.
    const executor = this.transport.kind === "ssh" ? this.connectionOptions?.executor : undefined;
    if (executor) {
      await killProcessesUnderDir(executor, `/tmp/openship-build-${sessionId}`, {
        includeSuffixed: true,
      });
    }

    // Attempt to find and kill the build container by label. Filtered on the label
    // KEY, not `key=value`: a compose service's container carries the derived
    // `<sessionId>-<serviceId>`, which an exact-value filter would never match.
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [OPENSHIP_LABEL.build] },
    });
    for (const c of containers) {
      const buildId = c.Labels?.[OPENSHIP_LABEL.build];
      if (!buildId || !cancelCovers(sessionId, buildId)) continue;
      try {
        await this.docker.getContainer(c.Id).remove({ force: true });
      } catch {
        /* already removed */
      }
    }
  }

  async getBuildLogs(sessionId: string): Promise<LogEntry[]> {
    void sessionId;
    return [];
  }

  // ── Deploy lifecycle ───────────────────────────────────────────────────

  async deploy(config: DeployConfig, onLog?: LogCallback): Promise<DeploymentResult> {
    const log = onLog ?? (() => {});
    const imageRef = config.imageRef;
    if (!imageRef) {
      throw new Error("Docker deploy requires an imageRef (built image tag)");
    }

    const containerName = `openship-${config.runtimeName || config.projectId}-${config.deploymentId}`;

    // Environment variables. A worker (config.portless) listens on nothing, so
    // injecting PORT would be a lie the app might bind to — omit it there (#538-B).
    const projectEnv = splitRuntimeEnv(config.envVars);
    if (projectEnv.dropped.length > 0) {
      log({
        timestamp: new Date().toISOString(),
        level: "warn",
        message: droppedRuntimeEnvMessage(projectEnv.dropped),
      });
    }
    const env = [
      ...(config.portless ? [] : [`PORT=${config.port}`]),
      `NODE_ENV=${config.environment === "production" ? "production" : "development"}`,
      ...projectEnv.entries.map(([k, v]) => `${k}=${v}`),
    ];

    // Start command - if provided, split into Cmd array
    const cmd = config.startCommand ? ["sh", "-c", config.startCommand] : undefined;

    const restartPolicy = resolveRestartPolicy(config.restartPolicy);

    // Persistent mounts. Each deploy creates a NEW container from a NEW image,
    // so anything the app wrote to its own filesystem is gone unless it lives on
    // a volume that outlives the container. Named volumes are project-scoped
    // through the same helper the multi-service path uses, so two projects can't
    // land on one daemon-level volume; bind mounts pass through.
    const scopedBinds = scopeVolumeBinds(
      config.slug || config.runtimeName || config.projectId,
      config.volumes ?? [],
      true,
    );
    const binds = scopedBinds.length > 0 ? scopedBinds : undefined;

    log({
      timestamp: new Date().toISOString(),
      message: `Creating container ${containerName} from ${imageRef}...\n`,
      level: "info",
    });
    if (binds) {
      log({
        timestamp: new Date().toISOString(),
        message: `Persistent storage: ${binds.join(", ")}\n`,
        level: "info",
      });
    }
    // State the caps in the build log. A silent 512 MB cap is how #333 hid: the
    // deploy reported ready while the container OOM-crash-looped, with nothing
    // anywhere saying a limit had been applied.
    log({
      timestamp: new Date().toISOString(),
      message: `Resource limits: ${describeResourceLimits(config.resources)}\n`,
      level: "info",
    });

    // Internal reachability (east-west): when an alias is set, join the project's
    // own `openship-<slug>` bridge network so another project explicitly linked to
    // this one (attachLinkedNetworks) can resolve it by name — the same DNS a
    // compose service gets. The alias existing is NOT public exposure: the network
    // is the project's boundary and stays empty until an explicit link joins a
    // consumer; loopback-only publishing below is untouched. Best-effort — a
    // network failure must not fail the deploy (the app still works via the edge).
    const aliasSlug = config.slug || config.runtimeName || config.projectId;
    let networkId: string | undefined;
    let aliases: string[] = [];
    if (config.networkAlias) {
      aliases = buildNetworkAliases(config.networkAlias, config.extraAliases);
      try {
        // ensureNetwork returns the network ID; the compose/service path also keys
        // EndpointsConfig + NetworkMode by the id, so mirror it here.
        networkId = await this.ensureNetwork(aliasSlug);
      } catch (err) {
        log({
          timestamp: new Date().toISOString(),
          message: `Warning: internal network setup failed (app still served via edge): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
          level: "warn",
        });
      }
    }

    const container = await this.docker.createContainer({
      name: containerName,
      Image: imageRef,
      // Hostname mirrors the primary alias so the container's own $HOSTNAME and
      // its network name agree (matches the compose/service path).
      ...(networkId ? { Hostname: config.networkAlias } : {}),
      Cmd: cmd,
      Env: env,
      Labels: this.labels({
        deploymentId: config.deploymentId,
        projectId: config.projectId,
        // Marks this single-app container as a network member so the label-scoped
        // reconcileNetworkMembership re-attaches it after an out-of-band network
        // rebuild, exactly like a compose service.
        ...(networkId ? { service: config.networkAlias } : {}),
      }),
      // A worker exposes and publishes no port (#538-B); everything else exposes
      // its app port for the loopback publish below.
      ...(config.portless ? {} : { ExposedPorts: { [`${config.port}/tcp`]: {} } }),
      ...(networkId
        ? { NetworkingConfig: { EndpointsConfig: { [networkId]: { Aliases: aliases } } } }
        : {}),
      HostConfig: {
        RestartPolicy: restartPolicy,
        Binds: binds,
        // Join the project's own bridge network as the primary network (mirrors
        // the compose path's NetworkMode: group.id). Egress + loopback publish are
        // unaffected; this only gives the container an in-network DNS identity.
        ...(networkId ? { NetworkMode: networkId } : {}),
        // Omitted entirely when the project has no cap (self-hosted default) —
        // see dockerResourceLimits. Never substitute a tier here.
        ...dockerResourceLimits(config.resources),
        // Publish on the LOOPBACK interface only — the edge (host process, or a
        // host-net OpenResty container) reaches it at 127.0.0.1:<hostPort>, and
        // it never faces the network. Binding 0.0.0.0 here would expose every
        // app directly, bypassing the edge's SSL/rate-limit/rules (and Docker's
        // iptables bypass ufw). A pinned `config.hostPort` (loopback-port route
        // strategy) is stable across redeploys; otherwise a random loopback port.
        // A worker (config.portless) binds no host port at all (#538-B).
        ...(config.portless
          ? {}
          : {
              PortBindings: {
                [`${config.port}/tcp`]: [
                  { HostIp: "127.0.0.1", HostPort: config.hostPort ? String(config.hostPort) : "" },
                ],
              },
            }),
      },
    });

    await container.start();

    log({
      timestamp: new Date().toISOString(),
      message: `Container ${container.id.slice(0, 12)} started.\n`,
      level: "info",
    });

    return {
      deploymentId: config.deploymentId,
      containerId: container.id,
      status: "running",
    };
  }

  async stop(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop();
  }

  async start(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.start();
  }

  async restart(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.restart();
  }

  async removeImage(imageRef: string): Promise<void> {
    // A path is not an image. Guarding at the verb — not only at the callers that
    // classify — is what makes issue #640 unrepeatable: dockerode would happily
    // issue `DELETE /images//opt/openship/static/...`, whose failure is not a 404
    // and so is rethrown, failing a project teardown forever. Callers that can
    // hold either shape must route a path to destroy() instead.
    if (isArtifactPathRef(imageRef)) {
      throw new Error(
        `"${imageRef}" is a host directory, not an image reference — remove it with destroy().`,
      );
    }
    const image = this.docker.getImage(imageRef);
    try {
      await image.remove({ force: true });
    } catch (err) {
      // Idempotent: swallow "not found" / 404 so partial-cleanup retries
      // don't re-fail on already-deleted images. Re-throw anything else
      // (permission denied, image in use by other tags, daemon down, ...).
      if (!isDockerNotFoundError(err)) throw err;
    }
  }

  async destroy(containerId: string): Promise<void> {
    // An absolute-path id is a static build/release DIRECTORY on the host that
    // this runtime produced via buildStaticToHost — not a container.
    // getContainer().remove() would 404-no-op and leak the dir, so rm it via the
    // same transport buildStaticToHost used (SSH exec, else local fs).
    //
    // `removeManagedArtifact` owns the confinement AND the verification: it
    // refuses a path outside the managed tree, and it THROWS when the directory
    // survives the remove. Both were missing here, and the second one mattered
    // most — the old `.catch(() => {})` made an artifact destroy incapable of
    // failing, so teardown reported success over a directory still on disk.
    if (isArtifactPathRef(containerId)) {
      if (this.transport.kind === "ssh") {
        const executor = this.connectionOptions?.executor;
        // Falling through to node:fs on an SSH transport removed the path on the
        // ORCHESTRATOR's filesystem — the wrong machine — and reported success.
        // Every other ssh-only branch in this file throws for the same reason.
        if (!executor) {
          throw new Error(
            `Cannot remove ${containerId}: the SSH transport has no command executor, and ` +
              `removing it locally would delete the wrong machine's files.`,
          );
        }
        await removeManagedArtifact(executor, containerId);
        return;
      }
      await removeManagedArtifact(null, containerId);
      return;
    }
    const container = this.docker.getContainer(containerId);
    try {
      await gracefulStopForGrace(container); // #388: honor stop_grace_period before the SIGKILL
      await container.remove({ force: true });
    } catch (err) {
      // Idempotent: swallow "no such container" / 404 so partial-cleanup
      // retries don't re-fail on already-deleted containers. Re-throw
      // anything else (permission denied, daemon down, dependent state).
      if (!isDockerNotFoundError(err)) throw err;
    }
  }

  /**
   * Every container (running OR stopped) labeled for this project. Lets
   * project teardown reclaim orphans that have no DB row — e.g. a deploy
   * that started a container then failed during routing, or rows lost to
   * a crash. The `openship.project` label is stamped at create time
   * (see `labels()`), so this is authoritative for THIS docker host.
   */
  async listProjectContainerIds(projectId: string): Promise<string[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`openship.project=${projectId}`] },
    });
    return containers.map((c) => c.Id);
  }

  /**
   * Built images that belong to this project — the label `openship.project=<id>`
   * that `labels()` stamps on every FINAL build image. Base/third-party images
   * (postgres, redis, …) are PULLED, never labeled, so they can never appear
   * here — that label filter is the primary guardrail for the image GC, which
   * reconciles this on-host set against the DB keep-set. Includes untagged
   * (dangling) superseded finals: labels persist after the tag is removed.
   */
  async listProjectImages(projectId: string): Promise<
    Array<{
      id: string;
      repoTags: string[];
      buildId?: string;
      deploymentId?: string;
      size: number;
      /** Image creation time (epoch ms); null when the daemon didn't report one. */
      createdAt: number | null;
    }>
  > {
    const images = await this.docker.listImages({
      filters: { label: [`openship.project=${projectId}`] },
    });
    return images.map((img) => ({
      id: img.Id,
      repoTags: (img.RepoTags ?? []).filter((t) => t && t !== "<none>:<none>"),
      buildId: img.Labels?.[OPENSHIP_LABEL.build],
      deploymentId: img.Labels?.[OPENSHIP_LABEL.deployment],
      size: img.Size ?? 0,
      // Docker reports seconds; every other timestamp in this codebase is ms.
      createdAt: typeof img.Created === "number" && img.Created > 0 ? img.Created * 1000 : null,
    }));
  }

  /**
   * Reclaim dangling (untagged) images carrying THIS project's label — the
   * superseded final-stage layers a rebuild leaves behind. NEVER a bare
   * `docker image prune`: the label filter guarantees base/other-project/other-
   * tool dangling layers are untouched. (Unlabeled multi-stage intermediate
   * layers under the classic builder aren't caught — BuildKit avoids them.)
   */
  async pruneProjectDanglingImages(projectId: string): Promise<void> {
    try {
      await this.docker.pruneImages({
        filters: { dangling: ["true"], label: [`openship.project=${projectId}`] },
      });
    } catch {
      /* best-effort — a prune failure must never fail a build/deploy */
    }
  }

  /**
   * Containers labeled for this deployment, with live state — the reconcile
   * read-back. `State` is dockerode's `running | exited | paused | ...`; map it
   * to ContainerStatus the same way getContainerInfo does. Absence is conveyed
   * by an EMPTY list (no container carries the label), which the reconciler
   * reads as drift for the expected services.
   */
  async listDeploymentContainers(
    deploymentId: string,
  ): Promise<Array<{ containerId: string; status: ContainerStatus; serviceName?: string }>> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`openship.deployment=${deploymentId}`] },
    });
    const stateMap: Record<string, ContainerStatus> = {
      running: "running",
      healthy: "running",
      starting: "running",
      restarting: "running",
      exited: "stopped",
      paused: "stopped",
      created: "stopped",
      dead: "failed",
      unhealthy: "failed",
    };
    return containers.map((c) => ({
      containerId: c.Id,
      status: stateMap[(c.State ?? "").toLowerCase().trim()] ?? "stopped",
      serviceName: c.Labels?.[OPENSHIP_LABEL.service],
    }));
  }

  // ── Rollback primitives (retention half only) ────────────────────────
  //
  // Docker deliberately does NOT implement `makeActive` — see the
  // "unitRestore" capability. A redeploy REMOVES the previous container
  // (loopback-port routing can't overlap two containers on one host
  // port), so there is no unit left to restart; the durable artifact is
  // the IMAGE. Restore therefore re-materializes the container through
  // the normal deploy step from the target's frozen snapshot + retained
  // image (modules/deployments/rollback/restore-plan.ts), which is the
  // only way env, published port, volumes, labels, network and routing
  // all come back correctly.
  //
  //   archive — `docker stop` (usually a no-op: the container is gone).
  //             The image stays tagged, retained by the rollback-window
  //             keep-set in modules/deployments/image-gc.
  //   purge   — `docker rm` (force) + `docker rmi`. Past this point an
  //             instant restore of this deployment is impossible and
  //             rollback degrades to a rebuild from its commit.

  async archive(deployment: DeploymentRef): Promise<void> {
    if (!deployment.containerId) return; // already archived (no container) or never deployed
    try {
      await this.stop(deployment.containerId);
    } catch {
      // already stopped — ignore
    }
  }

  async purge(deployment: DeploymentRef): Promise<void> {
    // Purge order: container first, then image — an image cannot be untagged
    // while a container references it.
    //
    // Neither failure is swallowed. `destroy` and `removeImage` already absorb
    // 404 / "no such container" internally, so replays stay idempotent and
    // anything reaching here is a real failure (permission denied, daemon down,
    // a dependent container). The caller reads a resolved purge as "the artifact
    // is gone" and clears `artifact_retained_at`, so a catch-all here records a
    // container or image still on the box as reclaimed — and it lies in the
    // direction that loses data, since a row that still HAS its image can still
    // be restored instantly.
    //
    // Both are attempted even when the first fails, so one stuck container does
    // not strand the image too.
    const failures: unknown[] = [];
    if (deployment.containerId) {
      await this.destroy(deployment.containerId).catch((err: unknown) => failures.push(err));
    }
    if (deployment.imageRef && ownsBuiltImage(deployment.imageRef)) {
      await this.removeImage(deployment.imageRef).catch((err: unknown) => failures.push(err));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new Error(
        failures.map((err) => (err instanceof Error ? err.message : String(err))).join("; "),
      );
    }
  }

  /**
   * Inspect a container and return the names of its **named** volumes -
   * the ones that survive `container.remove()` and would otherwise leak.
   * Anonymous volumes are auto-removed with `{ v: true }` and don't need to
   * be enumerated. Bind mounts and tmpfs are skipped (the user manages them
   * outside our control). Returns [] only if the container is already gone;
   * transport and permission failures propagate so an explicit volume wipe
   * never destroys the last copy of its mount inventory.
   */
  async inspectNamedVolumes(containerId: string): Promise<string[]> {
    try {
      const container = this.docker.getContainer(containerId);
      const data = await container.inspect();
      const mounts = (data.Mounts ?? []) as Array<{ Type?: string; Name?: string }>;
      return mounts
        .filter((m) => m.Type === "volume" && typeof m.Name === "string" && m.Name.length > 0)
        .map((m) => m.Name as string);
    } catch (err) {
      if (isDockerNotFoundError(err)) return [];
      throw err;
    }
  }

  /** Remove a named volume by name. Already-gone is idempotent success. */
  async removeVolume(name: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(name);
      await volume.remove({ force: true });
    } catch (err) {
      if (!isDockerNotFoundError(err)) throw err;
    }
  }

  // ── Docker discovery (label-agnostic) ────────────────────────────────────
  //
  // Enumerate the ENTIRE daemon, not just openship-labeled resources. Powers
  // "migrate an existing Docker deployment": read whatever already runs on a
  // server (a compose stack or hand-run containers) so it can be adopted as an
  // Openship project. Strictly read-only.

  /** Every container on the host (running or stopped), summarized. */
  async listAllContainers(): Promise<DockerContainerSummary[]> {
    const containers = await this.docker.listContainers({ all: true });
    return containers.map((c) => {
      const labels = c.Labels ?? {};
      // The list view already carries the network map, so the live-state read
      // gets each container's internal IP without an inspect round-trip.
      const ip = firstNetworkIp(c.NetworkSettings?.Networks);
      return {
        id: c.Id,
        names: (c.Names ?? []).map((n) => n.replace(/^\//, "")),
        image: c.Image,
        imageId: c.ImageID,
        state: (c.State ?? "").toLowerCase().trim(),
        status: c.Status,
        labels,
        ports: (c.Ports ?? []).map((p) => ({
          privatePort: p.PrivatePort,
          ...(p.PublicPort ? { publicPort: p.PublicPort } : {}),
          type: (p.Type as string) ?? "tcp",
          ...(p.IP ? { ip: p.IP } : {}),
        })),
        mounts: (c.Mounts ?? []).map(normalizeDockerMount),
        ...(ip ? { ip } : {}),
        composeProject: labels["com.docker.compose.project"] || undefined,
        composeService: labels["com.docker.compose.service"] || undefined,
      };
    });
  }

  /** Full inspect of one container, normalized. Null if the container is gone. */
  async inspectContainer(id: string): Promise<DockerContainerDetail | null> {
    let data: Dockerode.ContainerInspectInfo;
    try {
      data = await this.docker.getContainer(id).inspect();
    } catch (err) {
      if (isDockerNotFoundError(err)) return null;
      throw err;
    }
    const labels = data.Config?.Labels ?? {};
    const hc = data.Config?.Healthcheck;
    const rp = data.HostConfig?.RestartPolicy;
    const configFiles = labels["com.docker.compose.project.config_files"];
    return {
      id: data.Id,
      name: (data.Name ?? "").replace(/^\//, ""),
      image: data.Config?.Image ?? data.Image,
      imageId: data.Image,
      state: (data.State?.Status ?? "").toLowerCase().trim() || "unknown",
      command: toStringArray(data.Config?.Cmd),
      entrypoint: toStringArray(data.Config?.Entrypoint),
      env: data.Config?.Env ?? [],
      workingDir: data.Config?.WorkingDir || undefined,
      labels,
      restart: rp?.Name ? { name: rp.Name, maximumRetryCount: rp.MaximumRetryCount } : undefined,
      networks: Object.keys(data.NetworkSettings?.Networks ?? {}),
      mounts: (data.Mounts ?? []).map(normalizeDockerMount),
      ports: normalizeInspectPorts(data),
      healthcheck: hc
        ? {
            test: hc.Test,
            interval: hc.Interval,
            timeout: hc.Timeout,
            retries: hc.Retries,
            startPeriod: hc.StartPeriod,
          }
        : undefined,
      resources: inspectResourceLimits(data.HostConfig),
      composeProject: labels["com.docker.compose.project"] || undefined,
      composeService: labels["com.docker.compose.service"] || undefined,
      composeConfigFiles: configFiles
        ? configFiles
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      composeWorkingDir: labels["com.docker.compose.project.working_dir"] || undefined,
    };
  }

  /** The image's baked-in default env (Config.Env). Discovery subtracts these
   *  from a container's env so only user-set vars are imported, not the dozen
   *  defaults a base image (postgres, node, …) ships with. [] if unavailable. */
  async inspectImageEnv(ref: string): Promise<string[]> {
    try {
      const data = await this.docker.getImage(ref).inspect();
      return data.Config?.Env ?? [];
    } catch {
      return [];
    }
  }

  /** The image's baked-in default CMD (exec-form tokens). Used by migration to
   *  drop a container's `command` when it merely restates the image default —
   *  re-specifying it (and wrapping in `sh -c`) defeats entrypoints that drop
   *  privileges by argv (postgres refuses to run as root otherwise). */
  async inspectImageCmd(ref: string): Promise<string[]> {
    try {
      const data = await this.docker.getImage(ref).inspect();
      return data.Config?.Cmd ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Ensure an image is present, pulling it if missing. THE single image-pull
   * path — reused by the deploy pipeline and the backup/migration executor so
   * connectivity lives in one place.
   *
   * Over an SSH transport the pull runs as a blocking `docker pull` through the
   * command executor, NOT dockerode's `pull` + `modem.followProgress`: the
   * progress stream tunneled over the SSH docker socket never emits `end`, so
   * followProgress hangs forever (this was the cross-server migration stall).
   * A local socket has no such issue, so it keeps the native dockerode pull.
   */
  async pullImage(ref: string, opts?: { force?: boolean }): Promise<void> {
    if (!opts?.force) {
      try {
        await this.docker.getImage(ref).inspect();
        return; // already present
      } catch {
        /* missing → pull below */
      }
    }
    // force → skip the present-check and always pull the tag, so a moved
    // mutable tag (:latest/:1) rolls forward on an "update" deploy.
    const executor = this.connectionOptions?.executor;
    if (executor) {
      // 10 min ceiling — large images over a slow link; still bounded so a
      // genuinely stuck pull surfaces instead of hanging the whole migration.
      const timeout = 10 * 60_000;
      const auth = await this.connectionOptions?.resolveRegistryAuth?.(ref);
      const config = auth ? dockerConfigJsonFor(auth) : null;
      if (!config) {
        // No Openship credential for this registry: the remote pulls with whatever it has
        // of its own, which is the behaviour every existing install depends on.
        await executor.exec(`docker pull ${sq(ref)}`, { timeout });
        return;
      }

      // A remote pull shells out on the TARGET, so it reads that host's credentials — which
      // is why a private image only worked if the operator had run `docker login` on every
      // server by hand.
      //
      // WHY A FILE AND NOT AN API CALL: dockerode takes an `authconfig` and would need no
      // file at all — and that is exactly what the local branch below does. It is not
      // available here: over the SSH transport `modem.followProgress` never receives `end`
      // and hangs forever (see this method's doc comment), so the CLI is the only usable
      // transport remotely, and the CLI reads credentials from exactly one place — a
      // `config.json` in the directory named by DOCKER_CONFIG. There is no env-var or
      // file-descriptor form. `docker login` would also work and is worse: it persists the
      // credential on a machine whose lifecycle Openship does not own.
      //
      // So: minimize the window instead. The secret goes in through `writeFile`, never argv
      // (an argument is visible in `ps` to every user on that box for the life of the
      // command). `mkdir -m 700` without `-p` creates the directory with its mode set
      // ATOMICALLY and FAILS if the path already exists — no window where it is
      // world-readable, and no chance of writing into a directory something else prepared.
      // Cleanup runs on the command's own exit path AND in the finally below, which is what
      // covers a timeout that kills the exec before it reaches its own `rm`.
      const dir = `/tmp/openship-pull-${crypto.randomUUID()}`;
      try {
        await executor.exec(`mkdir -m 700 ${sq(dir)}`);
        await executor.writeFile(`${dir}/config.json`, config);
        await executor.exec(`chmod 600 ${sq(dir)}/config.json`);
        await executor.exec(
          `DOCKER_CONFIG=${sq(dir)} docker pull ${sq(ref)}; rc=$?; rm -rf ${sq(dir)}; exit $rc`,
          { timeout },
        );
      } finally {
        await executor.exec(`rm -rf ${sq(dir)}`).catch(() => {});
      }
      return;
    }
    // dockerode does not read `~/.docker/config.json` the way the CLI does, so this pull
    // went out anonymous on a `docker login`-ed host and every private-image deploy failed
    // with an unauthorized manifest fetch (#581). Resolved per pull rather than cached: a
    // credential can be added while the API is running, and a stale "none" would outlive it.
    //
    // The INJECTED resolver wins — that is Openship's own credential store, which works on
    // every install shape and every target. The host config is the fallback, and only when
    // no resolver was supplied at all: an org that manages its registries in Openship
    // should not have a stray `docker login` on the box quietly override it.
    const authconfig = this.connectionOptions?.resolveRegistryAuth
      ? await this.connectionOptions.resolveRegistryAuth(ref)
      : await resolveDockerAuth(ref);
    try {
      const stream = await this.docker.pull(ref, authconfig ? { authconfig } : {});
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      // Name the registry and KEEP the daemon's reason. The credential we sent is
      // never echoed back in a pull error, while the reason is the only thing that
      // separates "manifest unknown" from "unauthorized" from "no space left on
      // device" — collapsing all of them into one generic sentence makes every failed
      // pull undiagnosable, which is a worse outcome than the one being guarded
      // against. `resolveDockerAuth` is deliberately OUTSIDE this catch: its own error
      // is already redacted and actionable, and must not be relabelled a pull failure.
      throw new Error(
        `Failed to pull ${ref} from ${registryForImage(ref)}: ${safeErrorMessage(err)}`,
      );
    }
  }

  /** Is this image tag present on THIS daemon? Distinguishes a locally-built
   *  image (must be transferred cross-server) from a registry tag (the target
   *  just pulls it). */
  async imageExistsLocally(ref: string): Promise<boolean> {
    const executor = this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;
    if (executor) {
      const out = await executor
        .exec(`docker image inspect ${sq(ref)} >/dev/null 2>&1 && echo yes || true`)
        .catch(() => "");
      return out.trim() === "yes";
    }
    try {
      await this.docker.getImage(ref).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stream `docker save <ref>` OUT of this daemon as a Readable — the source
   * half of a cross-server image move. No extra compression: image layers are
   * already gzip-compressed, so re-compressing burns CPU for ~nothing.
   *
   * Over SSH the save runs as a native `docker save` through the raw command
   * channel (rawExec) — the same reason pullImage/build avoid dockerode over the
   * tunnel: a streamed dockerode body over the streamlocal bridge is unreliable.
   * Local socket / TCP use dockerode's image.get() directly.
   */
  async saveImage(
    ref: string,
  ): Promise<{ stdout: Readable; awaitExit: Promise<{ code: number; stderr: string }> }> {
    const executor = this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;
    if (executor?.rawExec) {
      const { stdout, stderr, onClose } = await executor.rawExec(`docker save ${sq(ref)}`);
      let stderrBuf = "";
      stderr.on("data", (c: Buffer) => {
        stderrBuf += c.toString();
        if (stderrBuf.length > 16 * 1024) stderrBuf = stderrBuf.slice(-16 * 1024);
      });
      stderr.resume();
      return { stdout, awaitExit: onClose.then((code) => ({ code, stderr: stderrBuf.trim() })) };
    }
    const stdout = (await this.docker.getImage(ref).get()) as unknown as Readable;
    const awaitExit = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      stdout.on("end", () => resolve({ code: 0, stderr: "" }));
      stdout.on("error", reject);
    });
    return { stdout, awaitExit };
  }

  /**
   * Load an image tar (a `docker save` stream) INTO this daemon — the target
   * half of a cross-server image move. Over SSH the tar streams into a native
   * `docker load` stdin (execWithInput); local socket / TCP use dockerode's
   * loadImage. Throws on a non-zero load. Returns the reference `docker load`
   * reported ("Loaded image( ID)?: <ref>") so the caller can retag: a
   * save-by-id load is untagged AND restores under the CONFIG image id, which
   * differs from the source ref — tagging by the source id would fail.
   */
  async loadImage(body: Readable): Promise<string | undefined> {
    const executor = this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;
    if (executor?.execWithInput) {
      const { code, stderr, stdout } = await executor.execWithInput(`docker load`, body);
      if (code !== 0)
        throw new Error(`docker load exited ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
      return parseLoadedImageRef(stdout);
    }
    const stream = await this.docker.loadImage(body);
    let loadOutput = "";
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream as NodeJS.ReadableStream,
        (err) => (err ? reject(err) : resolve()),
        (ev: { stream?: string }) => {
          if (ev?.stream) loadOutput += ev.stream;
        },
      );
    });
    return parseLoadedImageRef(loadOutput);
  }

  /**
   * Apply a tag to an image (`docker tag <source> <target>`). Used after a
   * save-by-ID / load: `docker save <id>` loads UNTAGGED, so the target daemon
   * needs the original tag re-applied — the adopted service's deploy `imageRef`
   * is that tag. `source` is typically the sha id, `target` the tag. Idempotent.
   */
  async tagImage(source: string, target: string): Promise<void> {
    if (source === target) return;
    const executor = this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;
    if (executor) {
      await executor.exec(`docker tag ${sq(source)} ${sq(target)}`);
      return;
    }
    // dockerode tag wants repo + optional tag split.
    const [repo, tag] = target.includes(":")
      ? [target.slice(0, target.lastIndexOf(":")), target.slice(target.lastIndexOf(":") + 1)]
      : [target, undefined];
    await this.docker.getImage(source).tag({ repo, ...(tag ? { tag } : {}) });
  }

  /** Every named volume on the host. */
  async listAllVolumes(): Promise<DockerVolumeInfo[]> {
    const res = await this.docker.listVolumes();
    return (res?.Volumes ?? []).map((v) => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      labels: v.Labels ?? {},
      composeProject: v.Labels?.["com.docker.compose.project"] || undefined,
    }));
  }

  /** Every network on the host. */
  async listAllNetworks(): Promise<DockerNetworkInfo[]> {
    const nets = await this.docker.listNetworks();
    return nets.map((n) => ({
      id: n.Id,
      name: n.Name,
      driver: n.Driver,
      labels: n.Labels ?? {},
      composeProject: n.Labels?.["com.docker.compose.project"] || undefined,
    }));
  }

  // ── Observability ──────────────────────────────────────────────────────

  async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    const container = this.docker.getContainer(containerId);
    let data: Dockerode.ContainerInspectInfo;
    try {
      data = await container.inspect();
    } catch (err) {
      // ABSENT: the daemon has no such container — it was removed out-of-band.
      // Report `missing` (drift) rather than throwing; a genuine connection
      // failure (unreachable host) is NOT 404 and still propagates so callers
      // can tell "gone" from "can't reach".
      if (isDockerNotFoundError(err)) {
        return { containerId, status: "missing" };
      }
      throw err;
    }

    const statusMap: Record<string, ContainerInfo["status"]> = {
      running: "running",
      healthy: "running",
      starting: "running",
      restarting: "running",
      exited: "stopped",
      paused: "stopped",
      created: "stopped",
      dead: "failed",
      unhealthy: "failed",
    };

    const startedAt = data.State.StartedAt;
    const uptimeSeconds =
      startedAt && data.State.Running
        ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
        : undefined;

    const { ip, hostPort, hostPortByContainerPort } = extractNetworkInfo(data);

    let status: ContainerInfo["status"];
    if (data.State.Running) {
      status = "running";
    } else if (data.State.Paused) {
      status = "stopped";
    } else {
      const rawStatus = (data.State.Status ?? "").toLowerCase().trim();
      status = statusMap[rawStatus] ?? "stopped";
    }

    return {
      containerId,
      status,
      ip,
      hostPort,
      ...(hostPortByContainerPort ? { hostPortByContainerPort } : {}),
      uptimeSeconds: uptimeSeconds && uptimeSeconds > 0 ? uptimeSeconds : undefined,
    };
  }

  /**
   * One stabilization reading for the post-deploy watch. Unlike
   * `getContainerInfo` this keeps `restarting` distinct and carries
   * `RestartCount` / `ExitCode` / health — the only fields that separate a
   * container that is UP from one that is bouncing. A vanished container is a
   * `missing` sample (not a throw): that is a verdict, not a transport error.
   */
  async sampleStability(containerId: string): Promise<ContainerStabilitySample> {
    let data: Dockerode.ContainerInspectInfo;
    try {
      data = await this.docker.getContainer(containerId).inspect();
    } catch (err) {
      if (isDockerNotFoundError(err)) {
        return {
          state: "missing",
          exitCode: null,
          restartCount: 0,
          health: null,
          errorLine: null,
          oomKilled: false,
          restartPolicy: null,
        };
      }
      throw err;
    }

    const rawState = (data.State?.Status ?? "").toLowerCase().trim();
    const state: ContainerStabilitySample["state"] = (
      ["created", "running", "restarting", "paused", "exited", "dead", "removing"] as const
    ).includes(rawState as never)
      ? (rawState as ContainerStabilitySample["state"])
      : "unknown";

    const rawHealth = (data.State?.Health?.Status ?? "").toLowerCase().trim();
    const health: ContainerStabilitySample["health"] =
      rawHealth === "healthy" || rawHealth === "unhealthy" || rawHealth === "starting"
        ? rawHealth
        : null;

    return {
      state,
      exitCode: typeof data.State?.ExitCode === "number" ? data.State.ExitCode : null,
      restartCount: typeof data.RestartCount === "number" ? data.RestartCount : 0,
      health,
      errorLine: data.State?.Error?.trim() ? data.State.Error.trim() : null,
      oomKilled: data.State?.OOMKilled === true,
      restartPolicy: data.HostConfig?.RestartPolicy?.Name ?? null,
    };
  }

  /**
   * Host-wide container event subscription (`GET /events`, filtered server-side).
   *
   * Runs on a DEDICATED dockerode instance rather than `this.docker`, for two
   * reasons that both bite silently:
   *   1. docker-modem applies its per-instance `timeout` as an *inactivity*
   *      `req.setTimeout` on every request, streams included (modem.js) — and the
   *      SSH transport sets 600s, TCP 30s. A quiet box would have its event
   *      stream destroyed on a schedule. `timeout: 0` opts out — and the connect gets
   *      its own bound instead (`EVENT_CONNECT_TIMEOUT_MS`), as a real abort rather
   *      than a promise walked away from, since docker-modem 5 forwards an
   *      `abortSignal` to the underlying request.
   *   2. The details come from `daemonConnectionFrom` (the modem the runtime is
   *      already talking to) and NOT from a second `transport.establish()`: the
   *      SSH branch mints a new bridge per call while `close()` only closes the
   *      latest, so re-establishing would leak one per subscription.
   *
   * No `since` cursor: the consumer re-reads state on every (re)connect anyway,
   * which covers gaps the daemon has nothing left to replay for (box reboot).
   */
  async watchContainerEvents(handlers: {
    onEvent: (event: ContainerLifecycleEvent) => void;
    onClose: (err: Error | null) => void;
  }): Promise<() => void> {
    const conn = daemonConnectionFrom(this.docker);
    const events = new Dockerode({
      socketPath: conn.socketPath,
      host: conn.host,
      port: conn.port,
      protocol: conn.protocol,
      ca: conn.ca,
      cert: conn.cert,
      key: conn.key,
      timeout: 0,
    } as Dockerode.DockerOptions);

    const opening = new AbortController();
    let openTimedOut = false;
    const openDeadline = setTimeout(() => {
      openTimedOut = true;
      opening.abort();
    }, EVENT_CONNECT_TIMEOUT_MS);
    (openDeadline as unknown as { unref?: () => void }).unref?.();

    let stream: NodeJS.ReadableStream;
    try {
      stream = (await events.getEvents({
        filters: { type: ["container"], event: [...CONTAINER_EVENT_ACTIONS] },
        // Not in @types/dockerode's GetEventsOptions, but docker-modem 5 reads it
        // (modem.js: `optionsf.signal = options.abortSignal`).
        abortSignal: opening.signal,
      } as Dockerode.GetEventsOptions)) as unknown as NodeJS.ReadableStream;
    } catch (err) {
      // The abort surfaces as a generic AbortError; say what actually happened.
      throw openTimedOut
        ? new Error(
            `no answer from the docker event stream within ${Math.round(
              EVENT_CONNECT_TIMEOUT_MS / 1000,
            )}s`,
          )
        : err;
    } finally {
      // Disarmed once the stream is up: from here on the subscription is long-lived
      // and `destroy()` below is what ends it.
      clearTimeout(openDeadline);
    }

    let closed = false;
    /** Fire onClose at most once, and never after cleanup. */
    const finish = (err: Error | null) => {
      if (closed) return;
      closed = true;
      handlers.onClose(err);
    };

    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      if (closed) return;
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseContainerEventLine(line);
        if (event) handlers.onEvent(event);
      }
    });
    stream.on("error", (err: Error) => finish(err));
    stream.on("close", () => finish(null));
    stream.on("end", () => finish(null));

    return () => {
      if (closed) return;
      closed = true;
      (stream as unknown as { destroy?: () => void }).destroy?.();
    };
  }

  async getRuntimeLogs(containerId: string, tail?: number): Promise<LogEntry[]> {
    const container = this.docker.getContainer(containerId);
    const buffer = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: tail ?? 200,
    });

    const raw = stripDockerHeaders(buffer);

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const { timestamp, message } = parseTimestampedLine(line);
        return { timestamp, message, level: parseLogLevel(message) };
      });
  }

  async streamRuntimeLogs(
    containerId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    const container = this.docker.getContainer(containerId);
    const stream = (await container.logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      follow: true,
      tail: opts?.tail ?? 100,
    })) as unknown as NodeJS.ReadableStream;

    let destroyed = false;

    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      if (destroyed) return;
      buffer += stripDockerChunkHeader(chunk).toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const { timestamp, message } = parseTimestampedLine(line);
        onLog({ timestamp, message, level: parseLogLevel(message) });
      }
    });

    stream.on("end", () => {
      if (buffer && !destroyed) {
        onLog({
          timestamp: new Date().toISOString(),
          message: buffer,
          level: parseLogLevel(buffer),
        });
        buffer = "";
      }
    });

    return () => {
      if (!destroyed) {
        destroyed = true;
        (stream as any).destroy?.();
      }
    };
  }

  async getUsage(containerId: string): Promise<ResourceUsage> {
    const container = this.docker.getContainer(containerId);
    const stats = await container.stats({ stream: false });

    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const numCpus = stats.cpu_stats.online_cpus || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    const memoryMb = (stats.memory_stats.usage ?? 0) / (1024 * 1024);

    let networkRxBytes = 0;
    let networkTxBytes = 0;
    if (stats.networks) {
      for (const iface of Object.values(stats.networks)) {
        networkRxBytes += iface.rx_bytes ?? 0;
        networkTxBytes += iface.tx_bytes ?? 0;
      }
    }

    let diskBytes = 0;
    if (stats.blkio_stats?.io_service_bytes_recursive) {
      for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
        diskBytes += entry.value ?? 0;
      }
    }
    const diskMb = diskBytes / (1024 * 1024);

    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryMb: Math.round(memoryMb * 100) / 100,
      diskMb: Math.round(diskMb * 100) / 100,
      networkRxBytes,
      networkTxBytes,
    };
  }

  // ── Network ────────────────────────────────────────────────────────────

  async getContainerIp(containerId: string): Promise<string | null> {
    const container = this.docker.getContainer(containerId);
    const data = await container.inspect();

    for (const net of Object.values(data.NetworkSettings.Networks ?? {})) {
      if (net.IPAddress) return net.IPAddress;
    }
    return null;
  }

  /**
   * Open an interactive PTY shell inside a deployed container. Powers
   * the in-dashboard service terminal — see apps/api/src/modules/service-terminal/.
   *
   * Wire-up: dockerode's `container.exec({Tty: true, AttachStdin: true,
   * AttachStdout: true, AttachStderr: true})` returns an Exec handle.
   * Starting it with `{hijack: true, stdin: true}` gives a single bi-
   * directional Duplex carrying TTY bytes in both directions (when Tty
   * is true, stderr is merged into stdout — exactly what xterm expects).
   *
   * The returned ShellSession matches SshExecutor.openShell so the
   * websocket bridge in service-terminal.controller.ts is identical
   * across Docker + Cloud + SSH callers.
   */
  async openServiceShell(containerId: string, opts?: ShellOptions): Promise<ShellSession> {
    const container = this.docker.getContainer(containerId);
    const cols = clampShellWindow(opts?.cols, 80, 1, 1000);
    const rows = clampShellWindow(opts?.rows, 24, 1, 500);
    const term = opts?.term || "xterm-256color";

    // Probe shell availability: prefer bash, fall back to sh. Both
    // are safe to invoke as `cmd -c env-prefix exec target-shell` so
    // the chosen shell ends up as PID 1 of the exec (clean exit
    // semantics — closing stdin from the WS terminates the shell).
    const inspect = await container.inspect().catch(() => null);
    if (!inspect?.State.Running) {
      throw new Error(
        `Container ${containerId} is not running (status: ${inspect?.State.Status ?? "unknown"})`,
      );
    }

    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ["/bin/sh", "-lc", "exec $(command -v bash || echo /bin/sh)"],
      Env: [`TERM=${term}`],
    });

    // We need the raw bidirectional socket (with Tty:true it carries PTY bytes
    // with no multiplexing header), which dockerode gets via `{hijack: true}`.
    // We do NOT use that: under Bun the hijacked start never settles — the daemon
    // sends `101 UPGRADED` and Bun's node:http doesn't surface the upgrade to
    // docker-modem, so the promise hangs forever and the service terminal
    // connected and then sat silent on every Bun-based api (the Docker image and
    // the compiled desktop binary). Measured: Node 22 round-trips, Bun 1.3.1
    // hangs. `startExecStream` performs the same upgrade on a plain socket, so it
    // behaves identically on both — see docker-exec-stream.ts.
    const duplex = await startExecStream(
      daemonConnectionFrom(this.docker),
      (exec as unknown as { id: string }).id,
      { tty: true, stdin: true },
    );

    // Set the initial window. Dockerode's resize() POSTs
    // /exec/{id}/resize?h={rows}&w={cols}. Safe to call before any
    // data flows.
    try {
      await exec.resize({ h: rows, w: cols });
    } catch {
      // ignore — the shell will still work at its default size
    }

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    duplex.on("data", (chunk: Buffer) => stdout.write(chunk));
    // startExecStream hands back a PAUSED stream (it may hold the shell's first
    // prompt); flow it now that the sink is attached.
    duplex.resume();
    duplex.on("end", () => {
      stdout.end();
      stderr.end();
    });
    duplex.on("error", () => {
      stdout.end();
      stderr.end();
    });

    const stdin = new Writable({
      write(chunk, _enc, cb) {
        duplex.write(chunk, (err) => cb(err ?? undefined));
      },
      final(cb) {
        try {
          duplex.end();
        } catch {
          // already ended
        }
        cb();
      },
    });

    const closeListeners: Array<(code: number | null, signal?: string) => void> = [];
    let closed = false;
    const fireClose = (code: number | null, signal?: string) => {
      if (closed) return;
      closed = true;
      for (const cb of closeListeners) {
        try {
          cb(code, signal);
        } catch {
          /* listener bug shouldn't kill cleanup */
        }
      }
    };

    duplex.on("close", () => {
      // Best-effort exit-code lookup. exec.inspect() returns the code
      // for a finished exec; null/undefined means we couldn't reach
      // dockerd in time (network blip, container gone) — surface as -1.
      exec
        .inspect()
        .then((info) => fireClose(info.ExitCode ?? null))
        .catch(() => fireClose(null));
    });

    return {
      stdin,
      stdout,
      stderr,
      setWindow: (c, r) => {
        const sc = clampShellWindow(c, 80, 1, 1000);
        const sr = clampShellWindow(r, 24, 1, 500);
        // resize() returns a promise we deliberately ignore — the WS
        // bridge calls this on every resize event, swallowing the
        // promise prevents an unhandled rejection if the exec has
        // already exited.
        void exec.resize({ h: sr, w: sc }).catch(() => undefined);
      },
      close: (_signal?: string) => {
        try {
          duplex.end();
        } catch {
          /* already ended */
        }
        try {
          duplex.destroy();
        } catch {
          /* already destroyed */
        }
      },
      onClose: (cb) => {
        closeListeners.push(cb);
      },
    };
  }

  /**
   * Non-interactive one-shot exec INSIDE a container. Sibling of
   * `openServiceShell` for the advisory port probe and app prepare steps — reads
   * stdout, stderr and the exit code. Runs in the CONTAINER, not on the daemon
   * host (never use `this.executor` here).
   */
  private async execInContainer(
    containerId: string,
    command: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const container = this.docker.getContainer(containerId);
    const inspect = await container.inspect().catch(() => null);
    if (!inspect?.State.Running) {
      throw new Error(
        `Container ${containerId} is not running (status: ${inspect?.State.Status ?? "unknown"})`,
      );
    }

    const timeoutMs = opts?.timeout ?? DEFAULT_IN_CONTAINER_EXEC_TIMEOUT_MS;
    const watchdogCmd = buildInContainerExecCmd(command, timeoutMs);
    const watchdogMs = Number(watchdogCmd[watchdogCmd.length - 1]) * 1000;
    const startedAt = Date.now();

    const exec = await container.exec({
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: watchdogCmd,
    });

    // NO `hijack`, and it must stay that way — same trap DockerEdgeExecutor.run()
    // documents. Hijack makes docker-modem ask for a connection upgrade; the daemon
    // answers `101 Switching Protocols`, and under Bun node:http reports that as a
    // plain `response` instead of an `upgrade`, so modem turned every SUCCESSFUL
    // exec into `(HTTP code 101) unexpected - <the command's own stdout>`. The api
    // runs Bun (image + compiled desktop binary), so every app prepare step
    // (Convex `adminKey`) "failed" while actually succeeding, and a `mustSucceed`
    // step would have failed the whole deploy. Only interactive stdin needs the raw
    // socket — see `openServiceShell`, which hand-rolls the upgrade instead.
    const stream = await exec.start({ stdin: false });

    // Buffer raw bytes and frame-split at the end rather than piping through
    // modem.demuxStream: Tty:false output is multiplexed, frames straddle chunk
    // boundaries, and a whole-buffer parse also tolerates unframed output.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      // Deliberately the SAME deadline the container-side watchdog enforces, so
      // having one doesn't lengthen the caller's timeout. Whichever fires first,
      // the remote process still gets killed — this side only stops waiting.
      const timer = setTimeout(() => {
        stream.destroy?.();
        reject(new Error(`exec timed out after ${timeoutMs}ms`));
      }, watchdogMs);
      const settle = (err?: Error) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => settle());
      stream.on("close", () => settle());
      stream.on("error", (err: Error) => settle(err));
    });

    let stdout = "";
    let stderr = "";
    for (const frame of splitDockerFrames(Buffer.concat(chunks))) {
      if (frame.stdout) stdout += frame.data.toString("utf8");
      else stderr += frame.data.toString("utf8");
    }

    // The output stream can end while the exec is still marked Running with a
    // null ExitCode; resolveExecExitCode polls that window out and fails rather
    // than reading it as a success (see its doc).
    const exitCode = await resolveExecExitCode(exec);

    // The in-container watchdog fired: report it as the timeout it is, not as a
    // bare 143 (whose "output" would be a half-finished command's).
    if (exitCode === SIGTERM_EXIT_CODE && Date.now() - startedAt >= watchdogMs) {
      throw new Error(`exec timed out after ${timeoutMs}ms`);
    }

    return { exitCode, stdout, stderr };
  }

  /** Command runner scoped to the inside of the container (advisory port probe,
   *  app prepare steps). Throws on a non-zero exit with the command's own output
   *  as the message. */
  async inContainerExecutor(containerId: string): Promise<PortProbeExecutor> {
    return {
      exec: async (command: string, opts?: { timeout?: number }) => {
        const { exitCode, stdout, stderr } = await this.execInContainer(containerId, command, opts);
        // `exitCode &&` would have let 0 AND null through — and null is exactly
        // the "couldn't read the exit code" case, so a failed command's stdout
        // came back as its captured value. execInContainer no longer returns
        // null; this stays strict so it can't come back.
        if (exitCode !== 0) {
          throw new Error(stdout.trim() || stderr.trim() || `exec exited with code ${exitCode}`);
        }
        return stdout;
      },
    };
  }

  // ── Compose / multi-service ────────────────────────────────────────────

  /**
   * Ensure a project-level Docker network exists.
   * All services in a compose project share this network and can
   * reach each other by service name as hostname.
   */
  async ensureNetwork(slug: string): Promise<string> {
    const networkName = `openship-${slug}`;
    // list-then-create is check-then-act: two concurrent deploys for the same
    // slug would both miss and both create, yielding two networks with the same
    // name (Docker allows it) and ambiguous name lookups. Serialize per server.
    const critical = async () => {
      const networks = await this.docker.listNetworks({
        filters: { name: [networkName] },
      });

      // listNetworks does substring matching, verify exact name
      const existing = networks.find((n) => n.Name === networkName);
      if (existing) return existing.Id;

      const network = await this.docker.createNetwork({
        Name: networkName,
        Driver: "bridge",
        Labels: { "openship.network": slug },
      });
      return network.id;
    };
    return this.provisionLock ? this.provisionLock.run(critical) : critical();
  }

  async ensureServiceGroup(config: {
    deploymentId: string;
    projectId: string;
    slug: string;
  }): Promise<MultiServiceGroupHandle> {
    void config.deploymentId;
    const networkId = await this.ensureNetwork(config.slug);
    // Self-heal network membership. A container joins the network only at
    // CREATE time (see deployServiceWorkload). Normal/partial/smart redeploys
    // are fine — the network is reused by name so its id is stable and
    // survivors stay attached. This covers the narrow case where the network's
    // identity changed out-of-band (docker network prune/rm, daemon/host
    // rebuild): survivors fall off it and become unreachable by name
    // (ESERVFAIL). Reconnecting every project container here, once per deploy,
    // makes membership independent of that.
    await this.reconcileNetworkMembership(networkId, config.projectId);
    return { id: networkId };
  }

  /**
   * Join already-running containers (migration attach-live reuse) to a project's
   * `openship-<slug>` network with a DNS alias each — so a natively-deployed
   * service in the SAME project resolves them by name (e.g. a freshly-built `web`
   * reaching the reused `postgres:5432`). These containers keep their ORIGINAL
   * openship labels, so the label-scoped reconcileNetworkMembership never joins
   * them; this is the explicit, additive join (a network connect does NOT restart
   * the container or touch its volumes). Idempotent + best-effort per member.
   */
  async joinServiceGroupContainers(
    slug: string,
    members: Array<{ containerId: string; aliases: string[] }>,
  ): Promise<void> {
    if (members.length === 0) return;
    const networkId = await this.ensureNetwork(slug);
    const network = this.docker.getNetwork(networkId);
    for (const m of members) {
      if (!m.containerId) continue;
      const aliases = m.aliases.filter(Boolean);
      try {
        await network.connect({
          Container: m.containerId,
          EndpointConfig: aliases.length ? { Aliases: aliases } : {},
        });
      } catch (err) {
        // Already-on-network races are fine; anything else is swallowed — this is
        // best-effort and must never block the migration deploy.
        const msg = (err as { message?: string })?.message ?? "";
        if (!/already exists|already connected/i.test(msg)) {
          console.warn(
            `[docker] group join failed for ${m.containerId.slice(0, 12)} (${aliases.join(", ")}): ${msg}`,
          );
        }
      }
    }
  }

  /**
   * Guard for GRANDFATHERED (non-namespaced) services: a bare named volume that
   * another project's container already mounts is a cross-project collision —
   * the exact bug (two projects sharing one postgres volume) this change
   * prevents for new services. New namespaced services can't hit this (their
   * volume name is project-unique by construction).
   *
   * Only a FRESH claim is blocked: if THIS project already mounts the name
   * (it's the incumbent) a redeploy is never blocked — otherwise, during an
   * active collision, whichever owner redeployed first would be locked out of
   * its own release. Best-effort on the list call; throws ONLY on a real
   * newcomer collision so the operator renames it.
   */
  private async assertNoForeignNamedVolumeCollision(
    config: MultiServiceDeployConfig,
  ): Promise<void> {
    const named = new Set<string>();
    for (const spec of config.volumes) {
      const body = spec.replace(/:(ro|rw|z|Z|nocopy)$/, "");
      const parts = body.split(":");
      if (parts.length < 2) continue; // anonymous / bare container path
      const source = parts[0];
      if (isHostPathSource(source)) continue; // bind mount
      named.add(source);
    }
    if (named.size === 0) return;

    let containers: Awaited<ReturnType<typeof this.docker.listContainers>>;
    try {
      containers = await this.docker.listContainers({ all: true });
    } catch {
      return; // never block a deploy on a docker list hiccup
    }

    // Names THIS project already mounts → it's the incumbent, never blocked.
    // Only a name held solely by ANOTHER project is a collision.
    const ownNames = new Set<string>();
    const foreign = new Map<string, string>(); // volume name → other container name
    for (const c of containers) {
      const owner = c.Labels?.[OPENSHIP_LABEL.project];
      if (!owner) continue;
      for (const m of c.Mounts ?? []) {
        if (m.Type !== "volume" || !m.Name || !named.has(m.Name)) continue;
        if (owner === config.projectId) ownNames.add(m.Name);
        else if (!foreign.has(m.Name))
          foreign.set(m.Name, c.Names?.[0]?.replace(/^\//, "") ?? owner);
      }
    }
    for (const [name, other] of foreign) {
      if (ownNames.has(name)) continue; // incumbent — allow the owner's redeploy
      throw new Error(
        `Volume "${name}" is already used by another project's container "${other}". ` +
          `Rename this service's volume to a project-unique name before deploying, ` +
          `to avoid overwriting the other project's data.`,
      );
    }
  }

  /**
   * Ensure every container belonging to this project is attached to
   * `networkId` with its service-name alias. Idempotent (already-connected is a
   * no-op) and best-effort (never throws). Normal/partial/smart redeploys don't
   * strand containers (the network is reused by name → stable id); this heals
   * the narrow case where the network's identity changed out-of-band (docker
   * network prune/rm, daemon/host rebuild) and surviving containers fell off it.
   */

  /**
   * A container that can never be attached to a network, because it doesn't own a
   * network namespace to attach (compose `network_mode: container:…`/`none`, or a
   * migration-adopted `host`).
   *
   * Both membership loops below are best-effort and swallow errors, so without this
   * they'd still work — they'd just log "connect failed" for such a container on
   * every single deploy, forever, over something that is correct by design. Read
   * from `HostConfig.NetworkMode`, which `/containers/json` reports.
   */
  private cannotJoinNetworks(container: { HostConfig?: { NetworkMode?: string } }): boolean {
    const mode = container.HostConfig?.NetworkMode;
    return !!mode && (mode.startsWith("container:") || mode === "none" || mode === "host");
  }

  private async reconcileNetworkMembership(networkId: string, projectId: string): Promise<void> {
    let containers: Awaited<ReturnType<typeof this.docker.listContainers>>;
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`openship.project=${projectId}`] },
      });
    } catch {
      return;
    }
    const network = this.docker.getNetwork(networkId);
    for (const c of containers) {
      // Skip containers already on this exact network object.
      const onNetwork = Object.values(c.NetworkSettings?.Networks ?? {}).some(
        (n) => n?.NetworkID === networkId,
      );
      if (onNetwork) continue;
      if (this.cannotJoinNetworks(c)) continue;
      const service = c.Labels?.[OPENSHIP_LABEL.service];
      try {
        await network.connect({
          Container: c.Id,
          EndpointConfig: service ? { Aliases: [service] } : {},
        });
      } catch (err) {
        // "already exists in network" races are fine; anything else is
        // swallowed — reconcile is best-effort and must not block deploy.
        const msg = (err as { message?: string })?.message ?? "";
        if (!/already exists|already connected/i.test(msg)) {
          // best-effort: leave a breadcrumb, don't throw
          console.warn(
            `[docker] reconcile connect failed for ${c.Id.slice(0, 12)} → ${networkId.slice(0, 12)}: ${msg}`,
          );
        }
      }
    }
  }

  /**
   * Attach every container of `projectId` to the given networks (by name) — for
   * cross-project service links: a consumer joins a linked database app's
   * `openship-<slug>` network so it resolves that app's service alias
   * (`mongo:27017`) with no public port. Best-effort + idempotent; a network that
   * doesn't exist (source not deployed) is skipped and nothing here ever throws —
   * a link networking failure must never fail the consumer's deploy.
   */
  async attachToExternalNetworks(
    projectId: string,
    networkNames: string[],
    extraContainerIds: string[] = [],
  ): Promise<void> {
    if (networkNames.length === 0) return;
    let containers: Awaited<ReturnType<typeof this.docker.listContainers>>;
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`openship.project=${projectId}`] },
      });
    } catch {
      return;
    }
    /**
     * The label filter alone is structurally blind to ADOPTED containers.
     *
     * A migration that reuses containers in place cannot relabel them — labels are
     * immutable — so an adopted container keeps its ORIGINAL `openship.*`/compose labels
     * and `openship.project=<id>` never matches it. Connect an app to a migrated project in
     * INTERNAL mode and the alias (`db:5432`) was written into the consumer's env while the
     * adopted container was never joined to the network: the connection simply failed to
     * resolve at runtime, and the UI reported success.
     *
     * So the caller may name containers explicitly — the same identity chain the READ paths
     * use (stored container id, not label) — and they are unioned in, de-duped by id.
     */
    if (extraContainerIds.length > 0) {
      const seen = new Set(containers.map((c) => c.Id));
      for (const id of extraContainerIds) {
        if (seen.has(id)) continue;
        try {
          const info = await this.docker.getContainer(id).inspect();
          containers.push({
            Id: info.Id,
            NetworkSettings: { Networks: info.NetworkSettings?.Networks ?? {} },
            HostConfig: { NetworkMode: info.HostConfig?.NetworkMode },
          } as unknown as (typeof containers)[number]);
          seen.add(info.Id);
        } catch {
          // Gone / unreachable — nothing to join. Never throws: a link networking
          // failure must not fail the consumer's deploy.
        }
      }
    }
    for (const name of networkNames) {
      const network = this.docker.getNetwork(name);
      let netId: string;
      try {
        const info = await network.inspect();
        netId = info.Id;
      } catch {
        continue; // network absent (source app not deployed) — skip
      }
      for (const c of containers) {
        const onNetwork = Object.values(c.NetworkSettings?.Networks ?? {}).some(
          (n) => n?.NetworkID === netId,
        );
        if (onNetwork) continue;
        if (this.cannotJoinNetworks(c)) continue;
        try {
          await network.connect({ Container: c.Id });
        } catch (err) {
          const msg = (err as { message?: string })?.message ?? "";
          if (!/already exists|already connected/i.test(msg)) {
            console.warn(`[docker] link-connect failed for ${c.Id.slice(0, 12)} → ${name}: ${msg}`);
          }
        }
      }
    }
  }

  /** Remove a project network. Already-gone is idempotent success. */
  async removeNetwork(slug: string): Promise<void> {
    const networkName = `openship-${slug}`;
    try {
      const network = this.docker.getNetwork(networkName);
      await network.remove();
    } catch (err) {
      if (!isDockerNotFoundError(err)) throw err;
    }
  }

  /**
   * Deploy a single service container on a project network.
   * Unlike `deploy()` which binds to a random host port,
   * service containers join the project network with their service name as hostname.
   * External port bindings are only created for services that explicitly expose ports.
   */
  async deployServiceWorkload(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    const log = onLog ?? (() => {});
    const containerName = `openship-${config.slug}-${config.serviceName}`;

    // Resolve and validate the complete create payload before any irreversible
    // action. A malformed later port/volume/health setting must not be discovered
    // only after the currently-serving container has already been removed.
    const serviceEnv = splitRuntimeEnv(config.environment);
    if (serviceEnv.dropped.length > 0) {
      log({
        timestamp: new Date().toISOString(),
        level: "warn",
        message: `[${config.serviceName}] ${droppedRuntimeEnvMessage(serviceEnv.dropped)}`,
      });
    }
    const env = [
      ...(config.publicPort && config.environment.PORT === undefined
        ? [`PORT=${config.publicPort}`]
        : []),
      ...serviceEnv.entries.map(([k, v]) => `${k}=${v}`),
    ];
    const cmd = resolveComposeCmd(config);
    const entrypoint = resolveComposeEntrypoint(config.advanced);
    const sharedNetwork = config.namespaces?.network;
    const sharesNetns = !!sharedNetwork && sharedNetwork !== "none";
    const ownsProjectEndpoint = ownsNetworkEndpoint(sharedNetwork);
    const sharedPid = config.namespaces?.pid;
    const { exposedPorts, portBindings } = parsePortBindings(config.ports);
    if (!config.namespaceVolumes) {
      await this.assertNoForeignNamedVolumeCollision(config);
    }
    const scopedBinds = scopeVolumeBinds(config.slug, config.volumes, config.namespaceVolumes);
    const binds = scopedBinds.length > 0 ? scopedBinds : undefined;
    const restartPolicy = resolveRestartPolicy(config.restart);
    const healthcheck = toDockerHealthcheck(config.advanced?.healthcheck);
    const stopConfig = toStopConfig(config.advanced);

    // Acquire an external image BEFORE touching the running container. This is
    // especially important for incoming-webhook redeploys of mutable tags: a
    // registry/auth/network failure must leave the currently-serving workload
    // intact instead of removing it and then discovering that no replacement
    // can be prepared.
    if (!config.imageAlreadyPrepared) {
      try {
        log({
          timestamp: new Date().toISOString(),
          message: `Pulling image ${config.image}...\n`,
          level: "info",
        });
        // Shared pull path — blocking `docker pull` over SSH so a first-time
        // pull on a fresh remote server can't hang (followProgress-over-SSH).
        await this.pullImage(config.image, { force: config.forcePull });
      } catch (err) {
        log({
          timestamp: new Date().toISOString(),
          message: `Failed to pull ${config.image}: ${err}\n`,
          level: "error",
        });
        throw err;
      }
    }

    // Stop and remove any existing container with the same name. A container that
    // declared a shutdown grace period (compose stop_grace_period, #388) gets a
    // graceful stop first so a redeploy of e.g. Postgres flushes instead of being
    // SIGKILLed mid-write; those that didn't opt in skip straight to force-remove.
    try {
      const existing = this.docker.getContainer(containerName);
      await gracefulStopForGrace(existing);
      await existing.remove({ force: true });
    } catch {
      // Does not exist - fine
    }

    // Environment variables. Inject PORT=<service port> (like the single-app
    // deploy path) so an app that binds `process.env.PORT` listens on the port
    // the route proxies to — otherwise a monorepo/compose backend (e.g. Express
    // `PORT || 5000`) binds a default that doesn't match its route → 502. Never
    // override a PORT the service already sets.
    // Filtered on this site too, and not only for our own generated images: this
    // path serves monorepo sub-app rows as well as compose rows, and a sub-app
    // image IS one of ours with node_modules/.bin baked into ENV PATH. The cost is
    // that a compose author who wrote `environment: PATH:` by hand no longer gets
    // `docker compose up` semantics — hence the warning rather than silence.
    log({
      timestamp: new Date().toISOString(),
      message: `Creating service container ${containerName} from ${config.image}...\n`,
      level: "info",
    });
    // Per-service caps, stated explicitly — see the single-app path for why.
    log({
      timestamp: new Date().toISOString(),
      message: `Resource limits: ${describeResourceLimits(config.resources)}\n`,
      level: "info",
    });
    // Say what sharing costs, in the build log, at the moment it's applied. A
    // silently-inert port list is how the operator ends up debugging a 502 against
    // a service that was never listening where they published it.
    if (sharedNetwork) {
      log({
        timestamp: new Date().toISOString(),
        message:
          `Network namespace: ${sharedNetwork} — this container gets no interface of its own` +
          (sharesNetns
            ? `, so its ports, project-network alias, and hostname come from the service it shares` +
              `. Publish and route on THAT service instead.\n`
            : ` and no network access at all.\n`),
        level: "warn",
      });
    }
    if (sharedPid) {
      log({
        timestamp: new Date().toISOString(),
        message: `PID namespace: ${sharedPid}\n`,
        level: "info",
      });
    }

    const container = await this.docker.createContainer({
      name: containerName,
      Image: config.image,
      Cmd: cmd,
      // Entrypoint (#575). SPREAD rather than assigned, because `undefined` and `[]`
      // must reach Docker differently: absent leaves the image's own ENTRYPOINT
      // alone, while `Entrypoint: []` clears it. Assigning `undefined` would send the
      // key, and the same conditional-spread shape is why `toStopConfig` returns an
      // object instead of nullable fields.
      ...(entrypoint === undefined ? {} : { Entrypoint: entrypoint }),
      Env: env,
      // Docker rejects an explicit hostname when the network namespace is another
      // container's — that container owns the UTS identity too.
      ...(sharesNetns ? {} : { Hostname: config.serviceName }),
      Labels: {
        ...this.labels({
          deploymentId: config.deploymentId,
          projectId: config.projectId,
        }),
        [OPENSHIP_LABEL.service]: config.serviceName,
      },
      ...(healthcheck && { Healthcheck: healthcheck }),
      ...stopConfig,
      ...(ownsProjectEndpoint ? { ExposedPorts: exposedPorts } : {}),
      HostConfig: {
        RestartPolicy: restartPolicy,
        ...dockerResourceLimits(config.resources),
        ...(ownsProjectEndpoint ? { PortBindings: portBindings } : {}),
        Binds: binds,
        // The project network is the default; a compose `network_mode` replaces it.
        NetworkMode: sharedNetwork ?? group.id,
        ...(sharedPid ? { PidMode: sharedPid } : {}),
      },
      // A declared network mode means there is no endpoint to name — omit the
      // block entirely rather than send an empty one (and never contradict
      // `NetworkMode: none` by attaching a network anyway).
      ...(ownsProjectEndpoint
        ? {
            NetworkingConfig: {
              EndpointsConfig: {
                [group.id]: {
                  // Default service name plus any operator-chosen aliases; both
                  // resolve to this container on the project network.
                  Aliases: buildNetworkAliases(config.serviceName, config.extraAliases),
                },
              },
            },
          }
        : {}),
    });

    try {
      await container.start();
    } catch (startErr) {
      // Clean up the created container so it doesn't become orphaned
      try {
        await container.remove({ force: true });
      } catch {
        /* best effort */
      }
      throw startErr;
    }

    // Get container IP on the project network
    const data = await container.inspect();
    const { ip, hostPort, hostPortByContainerPort } = extractNetworkInfo(data);

    // Record the content-addressable digest actually running so the update
    // scanner can later detect a moved mutable tag. Best-effort: a locally-built
    // image has no RepoDigests, and any inspect failure must not fail the deploy.
    const imageDigest = await this.resolveImageDigest(config.image).catch(() => undefined);

    log({
      timestamp: new Date().toISOString(),
      message: `Service ${config.serviceName} started (${container.id.slice(0, 12)})${ip ? ` at ${ip}` : ""}.\n`,
      level: "info",
    });

    return {
      containerId: container.id,
      status: "running",
      ip,
      hostPort,
      ...(hostPortByContainerPort ? { hostPortByContainerPort } : {}),
      imageDigest,
    };
  }

  /**
   * Resolve the `repo@sha256:…` digest of a pulled image from its RepoDigests,
   * preferring the entry whose repo matches `ref` (an image may carry digests
   * for several repos). Returns undefined for a locally-built image (no
   * RepoDigests) or any inspect error. Works local + SSH (plain inspect, no
   * followProgress). Never throws.
   */
  /**
   * PUBLIC because it is the only anchor the update scanner has.
   *
   * `resolveDeployedDrift` reads `service_deployment.image_digest` to tell a moved mutable
   * tag (`:latest`, `:16`) from an unchanged one — a REF comparison can't, since the ref
   * string is identical either way. A deploy records it here; an ADOPTED stack records
   * nothing, and an adopted stack is image-mode by definition (registry images, no repo),
   * so every migrated `postgres:16`/`redis:7` project was told "up to date" forever. The
   * adopt paths need to read it for a container they did not create.
   */
  async resolveImageDigest(ref: string): Promise<string | undefined> {
    const info = await this.docker.getImage(ref).inspect();
    const repoDigests: string[] = (info as { RepoDigests?: string[] })?.RepoDigests ?? [];
    if (repoDigests.length === 0) return undefined;
    // repo = ref without tag/digest (a colon after the last slash is the tag).
    const noDigest = ref.split("@")[0];
    const lastColon = noDigest.lastIndexOf(":");
    const lastSlash = noDigest.lastIndexOf("/");
    const repo = lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest;
    return repoDigests.find((d) => d.startsWith(`${repo}@`)) ?? repoDigests[0];
  }

  async deployService(
    config: MultiServiceDeployConfig & { networkId: string },
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    return this.deployServiceWorkload({ id: config.networkId }, config, onLog);
  }
}
