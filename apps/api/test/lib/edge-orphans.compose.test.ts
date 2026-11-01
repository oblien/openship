import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandExecutor } from "@repo/adapters";

const h = vi.hoisted(() => ({ executor: undefined as unknown as CommandExecutor }));
vi.mock("@repo/db", () => ({
  repos: {
    domain: { listAllHostnames: async () => [] },
    mailServer: { list: async () => [] },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: {} }));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({ platform: () => ({}) }));
vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createExecutor: () => h.executor,
}));

import { LocalExecutor } from "../../../../packages/adapters/src/system/local-executor";
import { scanEdgeOrphans } from "@repo/platform/engine/lib/edge-orphans.service";

const HOST = "forgotten.example.com";
const VHOST = `server { listen 80; server_name ${HOST}; location / { proxy_pass http://127.0.0.1:3009; } }`;
const paths = [
  "/var/lib/openship/edge/sites-enabled",
  "/usr/local/openresty/nginx/conf/sites-enabled",
  "/etc/openresty/sites-enabled",
];
const sq = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
let root: string;

beforeEach(async () => {
  vi.stubEnv("OPENSHIP_EDGE_MODE", "docker");
  vi.stubEnv("OPENSHIP_EDGE_CONTAINER", "openship-edge");
  vi.stubEnv("SHELL", "/bin/sh");
  root = await mkdtemp(join(tmpdir(), "openship-pr1003-scan-"));
  await mkdir(join(root, "layout-1"));
  await writeFile(join(root, "layout-1", "app.conf"), VHOST);
  await mkdir(join(root, "bin"));
  await symlink("/bin/cat", join(root, "bin", "cat"));
  await symlink("/bin/sh", join(root, "bin", "sh"));
  const executor = new LocalExecutor();
  const realExec = executor.exec.bind(executor);
  executor.exec = vi.fn(async (command, opts) => {
    // Run the actual scan command with real shell exit codes. Only remap its
    // fixed paths into our fixture; the available PATH deliberately has no Docker.
    let mapped = command;
    paths.forEach((path, index) => {
      mapped = mapped.replaceAll(path, join(root, `layout-${index}`));
    });
    return realExec(`PATH=${sq(join(root, "bin"))} /bin/sh -c ${sq(mapped)}`, opts);
  });
  h.executor = executor;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("finds mounted Compose routes when other candidate directories do not exist", async () => {
  expect(await scanEdgeOrphans()).toMatchObject({
    scanned: true,
    orphans: [{ hostname: HOST }],
  });
});

it("control finds the route when all three candidate globs match files", async () => {
  for (const index of [0, 2]) {
    await mkdir(join(root, `layout-${index}`));
    await writeFile(join(root, `layout-${index}`, "empty.conf"), "# empty layout\n");
  }
  expect(await scanEdgeOrphans()).toMatchObject({
    scanned: true,
    orphans: [{ hostname: HOST }],
  });
});

it("does not report an unreadable inventory as an empty successful scan", async () => {
  await rm(join(root, "layout-1"), { recursive: true, force: true });
  expect(await scanEdgeOrphans()).toMatchObject({ scanned: false, orphans: [] });
});

it("does not report a partial read as a successful scan", async () => {
  await writeFile(join(root, "layout-1", "unreadable.conf"), VHOST);
  await rm(join(root, "bin", "cat"));
  await writeFile(
    join(root, "bin", "cat"),
    '#!/bin/sh\ncase "$1" in *unreadable.conf) exit 1;; esac\nexec /bin/cat "$@"\n',
    { mode: 0o755 },
  );
  expect(await scanEdgeOrphans()).toMatchObject({ scanned: false, orphans: [] });
});
