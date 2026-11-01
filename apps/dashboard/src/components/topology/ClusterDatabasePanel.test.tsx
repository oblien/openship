// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterDatabase } from "@repo/contracts";
import { ClusterDatabasePanel } from "./ClusterDatabasePanel";
import { ProjectConnectionForm } from "@/app/(dashboard)/projects/[id]/components/UseInProjectModal";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  inspect: vi.fn(),
  connect: vi.fn(),
  update: vi.fn(),
  retry: vi.fn(),
  backup: vi.fn(),
  saved: vi.fn(),
  deploy: vi.fn(),
  getConnection: vi.fn(),
  candidates: vi.fn(),
  bundle: vi.fn(),
  scope: "account:org:instance",
  cluster: vi.fn(),
  clusters: vi.fn(),
}));
vi.mock("@/lib/api/compute-clusters", () => ({
  computeClustersApi: { get: h.cluster, list: h.clusters },
}));
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => h.scope }));
vi.mock("@/lib/api/apps", () => ({ appsApi: { getConnection: h.getConnection } }));
vi.mock("@/lib/api/connections", () => ({
  connectionsApi: { candidates: h.candidates, bundle: h.bundle },
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/api/cluster-databases", () => ({ clusterDatabasesApi: h }));
vi.mock("@/lib/api/cluster-storage", () => ({
  clusterStorageApi: { get: vi.fn(async () => null) },
}));
vi.mock("@/lib/api/backups", () => ({
  backupDestinationsApi: { list: vi.fn(async () => ({ data: [] })) },
}));
const row = (patch: Partial<ClusterDatabase> = {}): ClusterDatabase => ({
  id: "db",
  projectId: "project",
  clusterId: "cluster",
  name: "postgres",
  status: "ready",
  intent: "apply",
  generation: 1,
  sequence: 4,
  config: {
    engine: "postgres",
    mode: "standalone",
    instances: 1,
    storageClass: "openship-local",
    storageGiB: 20,
    cpuMillis: 500,
    memoryMiB: 512,
    databaseName: "app",
  },
  progress: { steps: [], logs: [] },
  observation: {
    ready: true,
    observedAt: new Date().toISOString(),
    primary: "database-1",
    message: "Ready",
    pods: [],
    volumes: [],
  },
  internalHost: "database.private",
  readOnlyHost: null,
  error: null,
  envKey: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...patch,
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  h.create.mockResolvedValue(row({ status: "provisioning" }));
  h.scope = "account:org:instance";
  h.cluster.mockResolvedValue({
    id: "cluster",
    name: "Kubernetes",
    scaling: { status: "ready", provider: "k3s" },
  });
  h.clusters.mockResolvedValue([]);
  h.remove.mockResolvedValue(row({ status: "deleting", intent: "remove" }));
  h.getConnection.mockResolvedValue({
    data: {
      outputs: [
        {
          id: "cluster-database:db",
          sourceDatabaseId: "db",
          clusterId: "cluster",
          label: "postgres",
          envKey: "DATABASE_URL",
          value: "postgres://private",
          secret: true,
          internal: true,
        },
        {
          id: "cluster-database:other",
          sourceDatabaseId: "other",
          clusterId: "cluster",
          label: "other database",
          envKey: "REDIS_URL",
          value: "redis://private",
          secret: true,
          internal: true,
        },
      ],
    },
  });
  h.candidates.mockResolvedValue({
    data: [
      { id: "consumer", name: "Compatible app", description: "", clusterId: "cluster" },
      { id: "different", name: "Other cluster", description: "", clusterId: "different-cluster" },
      { id: "docker", name: "Docker app", description: "", clusterId: null },
    ],
  });
  h.bundle.mockResolvedValue({});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === text)!;
const click = (target: HTMLElement) => act(async () => target.click());
async function render(database?: ClusterDatabase, databases: ClusterDatabase[] = []) {
  await act(async () =>
    root.render(
      <ClusterDatabasePanel
        projectId="project"
        clusterId="cluster"
        database={database}
        databases={databases}
        onSaved={h.saved}
        onDeploy={h.deploy}
        onClose={() => {}}
        onMinimize={() => {}}
      />,
    ),
  );
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("project database controls", () => {
  it("refuses a fixed Swarm target before creating a misleading database operation", async () => {
    h.cluster.mockResolvedValue({
      id: "cluster",
      name: "Swarm",
      scaling: { status: "ready", provider: "swarm" },
    });
    await render();
    expect(host.textContent).toContain("Managed database replication requires Kubernetes");
    const postgres = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("PostgreSQL"),
    )!;
    await click(postgres);
    expect(button("Create database").disabled).toBe(true);
    expect(h.create).not.toHaveBeenCalled();
  });
  it("does not submit an old settings draft against a newer database sequence", async () => {
    await render(row());
    await click(button("Database settings"));
    await render(row({ sequence: 5 }));
    expect(host.textContent).toContain("Settings changed");
    expect(button("Apply database settings").disabled).toBe(true);
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(h.update).not.toHaveBeenCalled();
  });
  it("opens reviewed replication scaling directly from the selected database", async () => {
    const database = row();
    h.update.mockResolvedValue(row({ status: "provisioning", sequence: 5 }));
    await render(database);
    await click(button("Scale"));
    await input(host.querySelector<HTMLInputElement>('input[type="number"]')!, "2");
    await click(button("Review scaling"));
    expect(h.update).not.toHaveBeenCalled();
    await click(button("Apply scaling"));
    expect(h.update).toHaveBeenCalledWith("project", {
      databaseId: "db",
      expectedSequence: 4,
      config: { ...database.config, mode: "cluster", instances: 3 },
    });
    expect(h.saved).toHaveBeenCalledWith(expect.objectContaining({ sequence: 5 }));
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("adds a private PostgreSQL reader connection without changing its writer", async () => {
    const database = row({
      config: { ...row().config, mode: "cluster", instances: 3 },
      envKey: "DATABASE_URL",
      readOnlyHost: "database-ro.private",
    });
    h.connect.mockResolvedValue({ ...database, readEnvKey: "DATABASE_READ_URL" });
    await render(database);
    expect(host.textContent).toContain("Queries must use this variable explicitly");
    expect(host.textContent).toContain("Replica data may lag");
    await click(button("Connect reads"));
    expect(h.connect).toHaveBeenCalledWith(
      "project",
      database,
      "DATABASE_URL",
      undefined,
      "DATABASE_READ_URL",
    );
    expect(h.deploy).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Review application deployment");
  });

  it("clears a reader connection independently and keeps removal blocked while it remains", async () => {
    const database = row({
      config: { ...row().config, mode: "cluster", instances: 3 },
      readEnvKey: "READ_URL",
    });
    h.connect.mockResolvedValue({ ...database, readEnvKey: null });
    await render(database);
    await click(button("Remove database"));
    expect(host.textContent).toContain("Disconnect the application before removing");
    expect(button("Stop and keep data")).toBeUndefined();
    await click(host.querySelector<HTMLElement>('[aria-label="Disconnect reader connection"]')!);
    expect(h.connect).toHaveBeenCalledWith("project", database, null, undefined, null);
  });

  it("does not save reader and writer credentials into the same environment variable", async () => {
    const database = row({
      config: { ...row().config, mode: "cluster", instances: 3 },
      envKey: "DATABASE_URL",
    });
    await render(database);
    const reader = [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Reader environment variable"))!
      .querySelector("input")!;
    await input(reader, "DATABASE_URL");
    expect(button("Connect reads").disabled).toBe(true);
    expect(host.textContent).toContain("Use different variables");
  });

  it("clears private draft and ignores an old operation response after account switching", async () => {
    let finish!: (row: ClusterDatabase) => void;
    h.connect.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const database = row();
    await render(database);
    await click(button("Connect application"));
    h.scope = "other:org:instance";
    await render(database);
    await act(async () => finish({ ...database, envKey: "DATABASE_URL" }));
    expect(h.saved).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Connection saved");
  });

  it("shares the selected native database through the existing form with compatible projects only", async () => {
    await render(row());
    await click(button("Use in a project"));
    const dialog = document.querySelector<HTMLElement>("[data-modal-surface]")!;
    expect(dialog.textContent).toContain("DATABASE_URL");
    expect(dialog.textContent).not.toContain("other database");
    expect(dialog.textContent).not.toContain("Public address");
    const select = dialog.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!;
    await click(select);
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["Compatible app"]);
    await click(options[0]);
    await click(
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Connect",
      )!,
    );
    expect(h.bundle).toHaveBeenCalledWith("consumer", {
      sourceProjectId: "project",
      items: [{ outputId: "cluster-database:db", envKey: "DATABASE_URL" }],
      mode: "internal",
    });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("keeps sharing disabled while the native database is not ready", async () => {
    await render(row({ status: "provisioning" }));
    expect(button("Use in a project").disabled).toBe(true);
    expect(h.getConnection).not.toHaveBeenCalled();
  });

  it("preserves Docker target choices until a native database is selected", async () => {
    await act(async () =>
      root.render(
        <ProjectConnectionForm
          sourceProjectId="project"
          onClose={() => {}}
          outputs={[
            {
              id: "dbUrl",
              service: "postgres",
              label: "Docker database",
              value: "postgres://docker",
              secret: true,
              recommended: true,
              envKey: "DOCKER_URL",
            },
            {
              id: "cluster-database:db",
              service: null,
              sourceDatabaseId: "db",
              clusterId: "cluster",
              label: "Native database",
              value: "postgres://native",
              secret: true,
              internal: true,
              envKey: "NATIVE_URL",
            },
          ]}
        />,
      ),
    );
    await click(host.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!);
    let options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options).toHaveLength(3);
    await click(options.find((option) => option.textContent === "Other cluster")!);
    await click(
      host.querySelector<HTMLElement>('[role="checkbox"][aria-label="Native database"]')!,
    );
    await click(host.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!);
    options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["Compatible app"]);
    expect(button("Connect").disabled).toBe(true);
  });

  it("requires an explicit review before switching an existing application connection", async () => {
    const original = row({
      id: "original",
      name: "original",
      envKey: "DATABASE_URL",
      sequence: 12,
    });
    const copy = row({ id: "upgraded", name: "upgraded", sourceDatabaseId: original.id });
    h.connect.mockResolvedValue({ ...copy, envKey: "DATABASE_URL" });
    await render(copy, [original, copy]);
    expect(button("Connect application").disabled).toBe(true);
    expect(host.textContent).toContain("Use upgraded instead of original");
    const review = [...host.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("Use upgraded instead of original"),
    )!;
    await click(review.querySelector<HTMLElement>('[role="checkbox"]')!);
    await click(button("Connect application"));
    expect(h.connect).toHaveBeenCalledWith("project", copy, "DATABASE_URL", {
      databaseId: "original",
      expectedSequence: 12,
    });
    expect(h.deploy).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Review application deployment");
  });
  it("makes a database upgrade a reviewed copy with the existing setup handled automatically", async () => {
    const database = row({
      config: {
        ...row().config,
        backup: { destinationId: "backups", schedule: "daily", retentionDays: 30 },
      },
    });
    await render(database);
    const details = [...host.querySelectorAll("details")].find(
      (item) => item.querySelector("summary")?.textContent === "Create an upgraded copy",
    )!;
    await click(details.querySelector("summary")!);
    expect(button("Create database copy").disabled).toBe(true);
    await click(details.querySelector<HTMLElement>('[role="checkbox"]')!);
    await act(async () =>
      details
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(h.create).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        config: expect.objectContaining({ version: "18" }),
        copyFrom: { databaseId: database.id, expectedSequence: database.sequence },
      }),
    );
    expect(h.deploy).not.toHaveBeenCalled();
  });
  it("keeps the catalog simple and locks a create until its saved record returns", async () => {
    let complete!: (row: ClusterDatabase) => void;
    h.create.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    expect(host.querySelector("input")).toBeNull();
    const postgres = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("PostgreSQL"),
    )!;
    await click(postgres);
    expect(host.textContent).toContain("Storage per instance");
    await act(async () => {
      button("Create database").click();
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(h.create).toHaveBeenCalledOnce();
    expect(button("Create database").disabled).toBe(true);
    await act(async () => complete(row({ status: "provisioning" })));
    expect(h.saved).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db", status: "provisioning" }),
    );
  });
  it("requires cluster-aware Redis clients and explains the six-server layout", async () => {
    await render();
    await click(
      [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Redis"))!,
    );
    await click(
      [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Standalone"),
      )!,
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((option) => option.textContent?.startsWith("Sharding"))!
        .click(),
    );
    expect(host.textContent).toContain("6 separate servers required");
    expect(button("Create database").disabled).toBe(true);
    await click(host.querySelector<HTMLElement>('[role="checkbox"]')!);
    expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    expect(button("Create database").disabled).toBe(false);
    // happy-dom's decimal step validation disagrees with browsers for 0.5 CPU.
    // Exercise submission here; Chromium checks the native form in the UI run.
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(h.create).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        clusterAwareClient: true,
        config: expect.objectContaining({ engine: "redis", mode: "cluster", instances: 3 }),
      }),
    );
  });
  it("requires the database name and defaults to keeping its data", async () => {
    const database = row();
    await render(database);
    await click(button("Remove database"));
    expect(button("Stop and keep data").disabled).toBe(true);
    await input(
      [...host.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("Type postgres to confirm"))!
        .querySelector("input")!,
      "postgres",
    );
    await click(button("Stop and keep data"));
    expect(h.remove).toHaveBeenCalledWith("project", database, "postgres", false);
  });
  it("shows only removal steps during a saved deletion", async () => {
    await render(row({ status: "deleting", intent: "remove" }));
    expect(host.textContent).toContain("Removing database");
    expect(host.textContent).toContain("Database removal");
    expect(host.textContent).not.toContain("Preparing persistent storage");
    expect(host.textContent).not.toContain("Connection and health checks");
  });
  it("restores a selected backup into a new database without changing the application's connection", async () => {
    const database = row();
    database.config.backup = { destinationId: "s3", schedule: "daily", retentionDays: 30 };
    database.envKey = "DATABASE_URL";
    database.observation!.backups = [
      {
        name: "backup-one",
        phase: "completed",
        startedAt: "2026-09-21T10:00:00Z",
        completedAt: "2026-09-21T10:01:00Z",
        error: null,
        backupId: "20260921T100000",
      },
    ];
    await render(database);
    await click(host.querySelector<HTMLElement>('[aria-label="Restore backup backup-one"]')!);
    await click(button("Restore database"));
    expect(h.create).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        name: "postgres-restored",
        restoreFrom: { databaseId: "db", backupName: "backup-one" },
      }),
    );
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("restores standalone Redis into a separate replicated database without a cutover", async () => {
    const database = row({
      config: {
        ...row().config,
        engine: "redis",
        backup: { destinationId: "s3", schedule: "daily", retentionDays: 30 },
      },
      envKey: "REDIS_URL",
    });
    database.observation!.backups = [
      {
        name: "snapshot",
        phase: "completed",
        startedAt: null,
        completedAt: null,
        error: null,
        backupId: "saved",
      },
    ];
    await render(database);
    await click(host.querySelector<HTMLElement>('[aria-label="Restore backup snapshot"]')!);
    await click(host.querySelector<HTMLElement>('[aria-label="New database deployment"]')!);
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
        node.textContent?.startsWith("Replication"),
      )!,
    );
    expect(host.textContent).toContain(
      "The original data and application connections stay unchanged",
    );
    await click(button("Restore database"));
    expect(h.create).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        name: "postgres-restored",
        config: expect.objectContaining({ mode: "replication", instances: 3 }),
        restoreFrom: { databaseId: "db", backupName: "snapshot" },
      }),
    );
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("keeps sharded Redis backups in their existing partition layout", async () => {
    const database = row({
      config: {
        ...row().config,
        engine: "redis",
        mode: "cluster",
        instances: 3,
        backup: { destinationId: "s3", schedule: "daily", retentionDays: 30 },
      },
    });
    database.observation!.backups = [
      {
        name: "shards",
        phase: "completed",
        startedAt: null,
        completedAt: null,
        error: null,
        backupId: "saved",
      },
    ];
    await render(database);
    await click(host.querySelector<HTMLElement>('[aria-label="Restore backup shards"]')!);
    expect(host.querySelector('[aria-label="New database deployment"]')).toBeNull();
    await click(button("Restore database"));
    expect(h.create).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        config: expect.objectContaining({ mode: "cluster", instances: 3 }),
        clusterAwareClient: true,
      }),
    );
  });
});
