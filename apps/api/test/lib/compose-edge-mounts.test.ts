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

interface ComposeFile {
  services: Record<string, { volumes?: string[]; image?: string }>;
  volumes?: Record<string, unknown> | null;
}

function compose(): ComposeFile {
  return parse(readFileSync(COMPOSE_PATH, "utf8")) as ComposeFile;
}

/** `host:container:z` → `host:container`, dropping the SELinux flag. */
function mountPairs(volumes: string[] | undefined): string[] {
  return (volumes ?? [])
    .filter((v) => v.startsWith("/") && !v.includes("docker.sock"))
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

  it("falls back to the shared registry default", () => {
    // The YAML's `${OPENSHIP_IMAGE_REGISTRY:-…}` is the fourth copy of this default
    // and the only one that can't import the constant.
    const image = compose().services.edge?.image ?? "";
    expect(image).toContain(`:-${DEFAULT_IMAGE_REGISTRY}}`);
    expect(image).toContain("/openship-edge:");
  });
});
