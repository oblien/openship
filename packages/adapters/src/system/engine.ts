/**
 * Which container engine does this box actually run?
 *
 * Openship drives containers through the Docker Engine API and the `docker`
 * CLI, but "docker" names the PROTOCOL, not the engine: Podman (4.x, 5.x, 6.x)
 * serves the same API through its compat socket, and on many hosts the `docker`
 * command is a shim that execs `podman`. Telling an operator "docker is ready"
 * on such a box points every later instruction — group membership, service
 * names, log locations — at a tool that was never there, so the checks name the
 * engine they actually found.
 *
 * Ground truth is `docker version`'s PLAIN output, which names both sides and
 * needs no format templates: the CLI strips `Platform`/`Components` from its
 * template structs (`docker version --format '{{.Server.Platform.Name}}'`
 * fails on Docker CLI 6.x and Podman 6.x alike — verified live), so `--format`
 * probes cannot see the engine name at all. The plain shapes are:
 *
 *   real dockerd              → "Client: Docker Engine …" / "Server: Docker Engine …"
 *   podman shim               → "Client: Podman Engine"    / "Server: Podman Engine"
 *   docker CLI → podman sock  → "Client: Docker Engine …" / "Server: Podman Engine"
 *   CLI present, daemon down  → client section only, still named
 *
 * When the SERVER section names an engine it wins (the daemon is what runs
 * containers); the CLIENT section is the fallback (a down daemon still leaves
 * the CLI's own name), then any podman/docker mention in the text.
 */

import type { ExecOnly } from "../types";
import { probeExec } from "./probe-exec";

/** The engines the Docker-compat surface can actually be backed by. */
export type ContainerEngine = "docker" | "podman";

/**
 * Read the engine name out of `docker version` / `docker --version` /
 * `podman --version` text. Null when nothing names an engine.
 */
export function parseEngineName(output: string): ContainerEngine | null {
  let client: ContainerEngine | null = null;
  for (const line of output.split(/\r?\n/)) {
    const section = line.match(/^(Server|Client):\s*(.*)$/i);
    if (!section) continue;
    const named = /podman/i.test(section[2])
      ? "podman"
      : /docker/i.test(section[2])
        ? "docker"
        : null;
    if (!named) continue;
    // The daemon's word beats the CLI's own: a real docker CLI pointed at a
    // podman socket reports "Server: Podman Engine", and Podman is what runs.
    if (section[1].toLowerCase() === "server") return named;
    client ??= named;
  }
  if (client) return client;
  // Section-less one-liners: `docker --version` on a real CLI ("Docker version
  // 29.7.1"), the shim ("podman version 5.8.2"), a podman-only fallback probe.
  // Gated on the text looking like a version answer at all: error noise that
  // merely contains the word docker ("sh: docker: not found") must not name it.
  if (/\bversion\b/i.test(output)) {
    if (/podman/i.test(output)) return "podman";
    if (/docker/i.test(output)) return "docker";
  }
  return null;
}

/**
 * Which engine answers this box's `docker` surface?
 *
 * `dockerVersionOutput` is the `docker --version` probe result when the caller
 * already ran one (null = the probe failed, i.e. no docker CLI). The shim
 * short-circuit makes the common Podman host a ZERO-extra-probe case: the shim
 * execs `podman`, so `docker --version` itself prints "podman version …".
 *
 * Returns null when nothing classifies — callers keep today's Docker wording,
 * which stays true for the Docker-API surface they talk to either way.
 */
export async function detectContainerEngine(
  executor: ExecOnly,
  dockerVersionOutput?: string | null,
): Promise<ContainerEngine | null> {
  // The `docker` command may BE Podman: on podman-docker shim hosts it execs
  // `podman`, so the CLI's own version names the engine directly.
  if (dockerVersionOutput && /podman/i.test(dockerVersionOutput)) return "podman";

  // Exit-0 forced: a down daemon makes `docker version` exit 1 while its
  // client section — which names the CLI — is exactly what we want back.
  // probeExec discards output of a failing command.
  const identity = await probeExec(executor, "docker version 2>&1 || true", "checks");
  if (identity.output && /^(Server|Client):/im.test(identity.output)) {
    const named = parseEngineName(identity.output);
    if (named) return named;
    // Sections but no engine name: keep the CLI's own word from --version.
    if (dockerVersionOutput) {
      return /docker/i.test(dockerVersionOutput) ? "docker" : null;
    }
  }

  // No usable docker CLI output: is Podman the engine that exists here?
  const podman = await probeExec(
    executor,
    "command -v podman >/dev/null 2>&1 && podman --version 2>&1 || true",
    "checks",
  );
  return podman.output ? parseEngineName(podman.output) : null;
}
