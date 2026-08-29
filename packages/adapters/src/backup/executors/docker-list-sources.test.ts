/**
 * `listSources`' DB fallback double-scoped an already-scoped volume name.
 *
 * The fallback runs whenever the container is gone — a stopped service, one destroyed
 * and not yet redeployed — which is exactly when a backup matters most. It applied the
 * `openship-<slug>-` prefix unconditionally, so a row storing the already-scoped name
 * resolved to `openship-<slug>-openship-<slug>-<name>`. Docker creates that on mount,
 * so the capture archived an empty volume and a restore wrote into one nothing reads.
 *
 * Only the fallback is exercised here: `containerId: null` is the branch, and it needs
 * no daemon.
 */

import { describe, expect, it } from "vitest";
import { DockerBackupExecutor } from "./docker";
import type { ServiceHandle } from "../types";

const executor = new DockerBackupExecutor({
  docker: {
    getContainer() {
      throw new Error("listSources must not touch the daemon when containerId is null");
    },
  },
} as never);

const handle = (volumes: string[], over: Partial<ServiceHandle> = {}): ServiceHandle =>
  ({
    id: "svc_1",
    projectId: "prj_1",
    projectSlug: "clincai",
    name: "db",
    image: "postgres:16",
    env: {},
    volumes,
    containerId: null,
    namespaceVolumes: true,
    ...over,
  }) as ServiceHandle;

describe("DockerBackupExecutor.listSources DB fallback", () => {
  it("scopes a bare named volume", async () => {
    const sources = await executor.listSources(
      handle(["pgdata:/var/lib/postgresql/data"]),
    );
    expect(sources).toEqual([
      {
        id: "openship-clincai-pgdata-0",
        source: "openship-clincai-pgdata",
        target: "/var/lib/postgresql/data",
        type: "volume",
      },
    ]);
  });

  it("does NOT re-scope a name already stored scoped", async () => {
    const sources = await executor.listSources(
      handle(["openship-clincai-pgdata:/var/lib/postgresql/data"]),
    );
    expect(sources.map((s) => s.source)).toEqual(["openship-clincai-pgdata"]);
  });

  it("leaves bind mounts and grandfathered services alone", async () => {
    const binds = await executor.listSources(handle(["/srv/data:/data"]));
    expect(binds.map((s) => s.source)).toEqual(["/srv/data"]);

    const bare = await executor.listSources(
      handle(["pgdata:/data"], { namespaceVolumes: false }),
    );
    expect(bare.map((s) => s.source)).toEqual(["pgdata"]);
  });

  it("keeps another project's prefix distinct rather than adopting it", async () => {
    const sources = await executor.listSources(handle(["openship-other-pgdata:/data"]));
    expect(sources.map((s) => s.source)).toEqual([
      "openship-clincai-openship-other-pgdata",
    ]);
  });
});
