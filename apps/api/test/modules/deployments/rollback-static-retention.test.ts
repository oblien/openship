import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BareRuntime, LocalExecutor } from "@repo/adapters";
import { repos, type Deployment } from "@repo/db";
import { seedOrg, seedProject, seedDeployment, setActive } from "../../helpers/seed";

const h = vi.hoisted(() => ({ runtime: null as BareRuntime | null }));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>(),
  resolveDeploymentRuntime: async () => ({ runtime: h.runtime!, serverId: null }),
}));
import { reconcileProjectRetention, setPin } from "@repo/platform/engine/modules/deployments/rollback/rollback-orchestrator";
import { updateProject } from "@repo/platform/engine/modules/projects/project-crud.service";

let root: string;
let project: Awaited<ReturnType<typeof seedProject>>;
let rows: Deployment[];
let paths: string[];
const exists = (path: string) => access(path).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openship-static-retention-"));
  h.runtime = new BareRuntime({ workDir: root, executor: new LocalExecutor() });
  const org = await seedOrg();
  project = await seedProject(org.organizationId, { rollbackWindow: 5, workloadType: "static", hasServer: false });
  paths = [];
  rows = [];
  for (let index = 0; index < 9; index += 1) {
    const row = await seedDeployment(project, {
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
      status: index === 1 ? "partial_failure" : "ready",
      artifactRetainedAt: new Date(),
      imageRef: null,
    });
    // An environment refresh can carry the old document root into a new row.
    const path = index === 8 ? paths[0]! : join(root, "releases", row.id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "index.html"), `release-${index}`);
    await repos.deployment.setContainerId(row.id, path);
    rows.push(row);
    paths.push(path);
  }
  await setActive(project.id, rows.at(-1)!.id);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.runtime?.dispose?.();
  await rm(root, { recursive: true, force: true });
});

it("removes expired static releases while preserving a reused live document root", async () => {
  expect((await reconcileProjectRetention(project.id)).purged).toBe(3);
  expect((await repos.deployment.findById(rows[0]!.id))!.artifactRetainedAt).toBeNull();
  expect(await readFile(join(paths[0]!, "index.html"), "utf8")).toBe("release-8");
  expect(await exists(paths[1]!)).toBe(false);
  expect(await exists(paths[2]!)).toBe(false);
  for (const path of paths.slice(3)) expect(await exists(path)).toBe(true);

  await updateProject(project.id, { rollbackWindow: 0 }, project.organizationId);
  for (const path of paths.slice(1, 8)) expect(await exists(path)).toBe(false);
  expect(await readFile(join(paths[0]!, "index.html"), "utf8")).toBe("release-8");
  expect((await repos.deployment.listByProject(project.id)).total).toBe(9);
});

it("keeps pinned files and retries a failed real directory cleanup", async () => {
  await setPin(rows[1]!.id, true);
  const destroy = h.runtime!.destroy.bind(h.runtime!);
  vi.spyOn(h.runtime!, "destroy").mockImplementation(async (path) => {
    if (path === paths[2]) throw new Error("Temporary filesystem failure");
    await destroy(path);
  });
  expect((await reconcileProjectRetention(project.id)).errors).toBe(1);
  expect(await exists(paths[1]!)).toBe(true);
  expect(await exists(paths[2]!)).toBe(true);
  expect((await repos.deployment.findById(rows[2]!.id))!.artifactRetainedAt).not.toBeNull();
  vi.restoreAllMocks();
  expect((await reconcileProjectRetention(project.id)).errors).toBe(0);
  expect(await exists(paths[2]!)).toBe(false);
  await setPin(rows[1]!.id, false);
  expect(await exists(paths[1]!)).toBe(false);
  expect(await exists(paths[0]!)).toBe(true);
});
