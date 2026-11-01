// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterDatabase } from "@repo/contracts";
import { ClusterDatabaseScaling } from "./ClusterDatabaseScaling";

const database = (patch: Partial<ClusterDatabase> = {}): ClusterDatabase => ({
  id: "database",
  projectId: "project",
  clusterId: "cluster",
  name: "Orders",
  status: "ready",
  intent: "apply",
  generation: 1,
  sequence: 7,
  config: {
    engine: "postgres",
    mode: "standalone",
    instances: 1,
    storageGiB: 20,
    storageClass: "openship-local",
    cpuMillis: 500,
    memoryMiB: 512,
    databaseName: "orders",
  },
  progress: { steps: [], logs: [] },
  observation: null,
  internalHost: "orders-rw.private",
  readOnlyHost: null,
  envKey: "DATABASE_URL",
  error: null,
  createdAt: "2026-10-19T09:00:00Z",
  updatedAt: "2026-10-19T09:00:00Z",
  ...patch,
});
let host: HTMLDivElement, root: Root;
const apply = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
const click = (node: HTMLElement) => act(async () => node.click());
async function render(row = database(), disabled = false) {
  await act(async () =>
    root.render(<ClusterDatabaseScaling database={row} disabled={disabled} onApply={apply} />),
  );
}
async function count(value: string) {
  await act(async () => {
    const node = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("reviewed database scaling", () => {
  it("reviews PostgreSQL primary plus readers before updating the exact saved sequence", async () => {
    apply.mockResolvedValue(database({ status: "provisioning", sequence: 8 }));
    await render();
    expect(host.textContent).toContain("1 primary + 0 read replicas");
    expect(button("Review scaling").disabled).toBe(true);
    await count("2");
    await click(button("Review scaling"));
    expect(apply).not.toHaveBeenCalled();
    expect(host.textContent).toContain("1 → 3");
    expect(host.textContent).toContain("60 GiB");
    expect(host.textContent).toContain("1.5 vCPU · 1536 MiB");
    expect(host.textContent).toContain("No servers are purchased automatically");
    await click(button("Apply scaling"));
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "postgres", mode: "cluster", instances: 3 }),
      7,
      undefined,
    );
  });

  it("holds one mutation while awaiting the saved operation", async () => {
    let complete!: (row: ClusterDatabase) => void;
    apply.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    await count("1");
    await click(button("Review scaling"));
    expect(host.textContent).toContain("writes pause if that replica is unavailable");
    await act(async () => {
      button("Apply scaling").click();
      button("Apply scaling").click();
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(button("Apply scaling").disabled).toBe(true);
    await act(async () => complete(database({ sequence: 8 })));
  });

  it("blocks a stale review until the latest configuration is reviewed", async () => {
    await render();
    await count("2");
    await click(button("Review scaling"));
    await render(
      database({ sequence: 8, config: { ...database().config, mode: "cluster", instances: 2 } }),
    );
    expect(host.textContent).toContain("changed after review");
    expect(button("Apply scaling").disabled).toBe(true);
    await click(button("Apply scaling"));
    expect(apply).not.toHaveBeenCalled();
    await click(button("Refresh draft"));
    expect(host.querySelector("input")!.value).toBe("1");
  });

  it("keeps unknown observations unknown and disables the current operation with guidance", async () => {
    await render(database(), true);
    expect(host.textContent).toContain("— / 1");
    expect(host.textContent).toContain("Wait for the current operation");
    expect(button("Review scaling").disabled).toBe(true);
  });

  it("blocks removing the final PostgreSQL reader while its connection is in use", async () => {
    const row = database({
      config: { ...database().config, mode: "cluster", instances: 3 },
      readEnvKey: "READ_URL",
    });
    await render(row);
    await count("0");
    expect(host.textContent).toContain("Disconnect reader connections");
    expect(button("Review scaling").disabled).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("scales Redis replication without treating followers as shards", async () => {
    const row = database({
      config: { ...database().config, engine: "redis", mode: "replication", instances: 3 },
    });
    await render(row);
    await count("3");
    await click(button("Review scaling"));
    expect(host.textContent).toContain("1 primary + 2 replicas");
    expect(host.textContent).not.toContain("redistributes keys");
    await click(button("Apply scaling"));
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "replication", instances: 4 }),
      7,
      undefined,
    );
  });

  it("keeps Redis replication downscaling behind the safe restore path", async () => {
    await render(
      database({
        config: { ...database().config, engine: "redis", mode: "replication", instances: 4 },
      }),
    );
    await count("2");
    expect(host.textContent).toContain("To reduce them, restore a backup");
    expect(button("Review scaling").disabled).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("requires a saved backup for shard redistribution and sends explicit review confirmation", async () => {
    const row = database({
      config: { ...database().config, engine: "redis", mode: "cluster", instances: 3 },
    });
    await render(row);
    await count("4");
    expect(button("Review scaling").disabled).toBe(true);
    expect(host.textContent).toContain("Configure a backup destination");
    await render({
      ...row,
      config: {
        ...row.config,
        backup: { destinationId: "s3", schedule: "daily", retentionDays: 30 },
      },
    });
    // A new config is never silently substituted into a draft opened earlier.
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({
      ...row,
      config: {
        ...row.config,
        backup: { destinationId: "s3", schedule: "daily", retentionDays: 30 },
      },
    });
    await count("4");
    await click(button("Review scaling"));
    expect(host.textContent).toContain("redistributes keys");
    await click(button("Apply scaling"));
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "cluster", instances: 4 }),
      7,
      true,
    );
  });

  it("keeps standalone Redis conversion explicit instead of creating unrelated replicas", async () => {
    await render(database({ config: { ...database().config, engine: "redis" } }));
    expect(host.textContent).toContain("restore a saved backup into a new replicated database");
    expect(host.querySelector("input")!.disabled).toBe(true);
    expect(button("Review scaling").disabled).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });
});
