import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import { EDGE_CONTAINER_MOUNTS, EDGE_HOST_STATE_DIR } from "@repo/adapters";
import { DEFAULT_IMAGE_REGISTRY } from "@repo/core";

/**
 * The shipped self-hosted stack (`docker/docker-compose.yml`) repeats the edge's
 * bind mounts as YAML literals, because compose interpolation can't read
 * TypeScript. That is the one copy of `EDGE_CONTAINER_MOUNTS` we cannot delete —
 * so it gets asserted instead.
 *
 * This is not busywork: a mount present in the array but missing from this file
 * reaches `docker run`-based installs and NOT compose ones, and the failure mode is
 * an install that serves nothing while every unit test passes. The api and edge
 * must mount the SAME host paths at the SAME container paths, or the api writes
 * vhosts/certs somewhere the edge never reads — the exact bug this whole area was
 * fixed for.
 */

const COMPOSE_PATH = join(import.meta.dirname, "../../../../docker/docker-compose.yml");

/**
 * The container path the host-op SSH key is mounted at, and the tolerant source
 * expression that mounts it.
 *
 * Both halves are load-bearing and neither is importable — the api reads the target
 * out of `OPENSHIP_HOST_SSH_KEY`, which `.env.example` and the docs tell operators to
 * set to this exact value, and compose resolves the source. The two drifting apart is
 * the "Cannot read host SSH key" bug: the docs said to set the env var while this file
 * mounted nothing (#509). `/dev/null` is the default on purpose — it is what lets the
 * stack start on a box with no key at all, rather than compose creating a DIRECTORY at
 * a missing bind source.
 */
const HOST_KEY_TARGET = "/run/secrets/openship_host_key";
const HOST_KEY_MOUNT = `\${OPENSHIP_HOST_KEY_PATH:-/dev/null}:${HOST_KEY_TARGET}:ro`;

interface ComposeFile {
  services: Record<string, { volumes?: string[]; image?: string }>;
  volumes?: Record<string, unknown> | null;
}

function compose(): ComposeFile {
  return parse(readFileSync(COMPOSE_PATH, "utf8")) as ComposeFile;
}

/**
 * Mounts that exist for reasons other than edge state, keyed by their CONTAINER
 * path: the docker socket, and the host SSH key.
 *
 * Excluded by TARGET rather than by "the source doesn't start with /", which is what
 * this filter used to do — the host-key mount escaped it only because its source is
 * `${OPENSHIP_HOST_KEY_PATH:-…}`. Hardcode that path one day and this suite fails
 * with a message about EDGE mounts, which is the wrong place to look (#509).
 */
const NON_EDGE_TARGETS = ["/var/run/docker.sock", HOST_KEY_TARGET];

/** `host:container:z` → `host:container`, dropping the SELinux flag. */
function mountPairs(volumes: string[] | undefined): string[] {
  return (volumes ?? [])
    .filter((v) => !NON_EDGE_TARGETS.some((t) => v.includes(t)))
    .map((v) => v.split(":").slice(0, 2).join(":"));
}

const expected = EDGE_CONTAINER_MOUNTS.map((m) => `${m.host}:${m.container}`);

describe("docker/docker-compose.yml — edge mounts match EDGE_CONTAINER_MOUNTS", () => {
  it("the edge service mounts exactly the canonical set", () => {
    expect(mountPairs(compose().services.edge?.volumes).sort()).toEqual([...expected].sort());
  });

  it("the api service mounts the same set (it WRITES what the edge reads)", () => {
    expect(mountPairs(compose().services.api?.volumes).sort()).toEqual([...expected].sort());
  });

  it("every mount is a HOST bind, never a named volume", () => {
    // A named volume here is what hid edge state from the migrate scan, cert carry
    // and cert reuse — all of which read the host.
    const declared = Object.keys(compose().volumes ?? {});
    for (const name of declared) {
      expect(EDGE_CONTAINER_MOUNTS.some((m) => m.host.includes(name))).toBe(false);
    }
    // Only the two data stores keep named volumes.
    expect(declared.sort()).toEqual(["postgres_data", "redis_data"]);
  });

  it("keeps certs and static doc-roots at the SAME path on both sides", () => {
    // What makes every existing host-side reader correct with no translation.
    const same = EDGE_CONTAINER_MOUNTS.filter((m) => m.host === m.container).map((m) => m.host);
    expect(same).toContain("/etc/letsencrypt");
    expect(same).toContain("/opt/openship/static");
  });

  it("relocated state lives under the canonical state dir", () => {
    for (const m of EDGE_CONTAINER_MOUNTS) {
      if (m.host === m.container) continue;
      expect(m.host.startsWith(EDGE_HOST_STATE_DIR)).toBe(true);
    }
  });

  it("mounts the host SSH key where OPENSHIP_HOST_SSH_KEY points, tolerantly", () => {
    // The CLI writes the same line into its generated compose file
    // (apps/cli/src/lib/compose.ts) — this is the raw-Docker copy of it.
    expect(compose().services.api?.volumes ?? []).toContain(HOST_KEY_MOUNT);
  });

  it("falls back to the shared registry default", () => {
    // The YAML's `${OPENSHIP_IMAGE_REGISTRY:-…}` is the fourth copy of this default
    // and the only one that can't import the constant.
    const image = compose().services.edge?.image ?? "";
    expect(image).toContain(`:-${DEFAULT_IMAGE_REGISTRY}}`);
    expect(image).toContain("/openship-edge:");
  });
});
