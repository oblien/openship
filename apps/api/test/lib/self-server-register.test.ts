import "../modules/mail/_setup-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "This Server" registration is owned by the box org, so it can't happen before
 * the founding admin exists — and a CLI install creates that admin AFTER the API
 * has booted, so a boot-only hook bailed and never retried. These pin the primitive
 * (gates, idempotency, no double-insert under concurrency) and the wiring: every
 * path that can satisfy the invariant calls it, because hanging registration off
 * ONE branch of bootstrap-admin is what left free-domain installs with no server
 * row (cloud-connect mirrors the admin first → bootstrap 409s → the CLI resets).
 */

const serverRepo = vi.hoisted(() => ({ findLocal: vi.fn(), create: vi.fn() }));
const boxOwningOrgId = vi.hoisted(() => vi.fn());
const resolveInstancePublicIp = vi.hoisted(() => vi.fn(async () => "203.0.113.9"));
const hostControlDisabled = vi.hoisted(() => vi.fn(() => false));

vi.mock("@repo/db", () => ({ repos: { server: serverRepo } }));
vi.mock("../../src/lib/box-org", () => ({ boxOwningOrgId }));
vi.mock("../../src/lib/server-target", () => ({ resolveInstancePublicIp }));
vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return { ...actual, hostControlDisabled };
});

import { ensureLocalServer } from "../../src/lib/startup/self-server";

const readSrc = async (rel: string) =>
  (await import("node:fs")).readFileSync(new URL(rel, import.meta.url), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  hostControlDisabled.mockReturnValue(false);
  serverRepo.findLocal.mockResolvedValue(null);
  serverRepo.create.mockImplementation(async (data) => ({ id: "srv_1", ...data }));
  boxOwningOrgId.mockResolvedValue("org_usr_1");
  resolveInstancePublicIp.mockResolvedValue("203.0.113.9");
});

afterEach(() => {
  delete process.env.SERVER_IP;
});

describe("ensureLocalServer", () => {
  it("registers the host in the box org, at its real address", async () => {
    const row = await ensureLocalServer();
    expect(row).toMatchObject({ id: "srv_1", isLocal: true });
    expect(serverRepo.create).toHaveBeenCalledWith({
      organizationId: "org_usr_1",
      name: "This Server",
      sshHost: "203.0.113.9",
      isLocal: true,
    });
  });

  // The boot-order case: no admin at boot → bail, then the SAME call succeeds once
  // an admin exists. This is exactly the sequence a CLI install produces.
  it("bails with no admin, then registers on the retry", async () => {
    boxOwningOrgId.mockResolvedValue(null);
    expect(await ensureLocalServer()).toBeNull();
    expect(serverRepo.create).not.toHaveBeenCalled();

    boxOwningOrgId.mockResolvedValue("org_usr_1");
    expect(await ensureLocalServer()).toMatchObject({ id: "srv_1" });
    expect(serverRepo.create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — returns the existing row, never a second one", async () => {
    serverRepo.findLocal.mockResolvedValue({ id: "srv_existing", isLocal: true });
    expect(await ensureLocalServer()).toMatchObject({ id: "srv_existing" });
    expect(serverRepo.create).not.toHaveBeenCalled();
  });

  // findLocal-then-create is read-modify-write: the boot hook, an install call and a
  // GET /servers can all land in the same tick on a fresh box. Single-flight is what
  // stops that from inserting three rows.
  it("collapses concurrent callers into ONE insert", async () => {
    const rows = await Promise.all([ensureLocalServer(), ensureLocalServer(), ensureLocalServer()]);
    expect(serverRepo.create).toHaveBeenCalledTimes(1);
    expect(serverRepo.findLocal).toHaveBeenCalledTimes(1);
    expect(new Set(rows.map((r) => r?.id))).toEqual(new Set(["srv_1"]));
  });

  it("re-checks after settling, so a deleted row comes back", async () => {
    await ensureLocalServer();
    await ensureLocalServer();
    expect(serverRepo.findLocal).toHaveBeenCalledTimes(2);
  });

  it("does NOT advertise the host when host control is off", async () => {
    hostControlDisabled.mockReturnValue(true);
    expect(await ensureLocalServer()).toBeNull();
    expect(serverRepo.create).not.toHaveBeenCalled();
  });

  it("prefers an explicit address + name (the adopt path)", async () => {
    await ensureLocalServer({ name: "Hetzner box", sshHost: "203.0.113.10" });
    expect(serverRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Hetzner box", sshHost: "203.0.113.10" }),
    );
    expect(resolveInstancePublicIp).not.toHaveBeenCalled();
  });
});

/**
 * The primitive is only load-bearing where it's called. Registration must not hang
 * off a single install branch — assert each seam by source, since wiring them up is
 * the actual fix.
 */
describe("wiring", () => {
  it("bootstrap-admin registers AFTER the admin row is written", async () => {
    const src = await readSrc("../../src/modules/system/setup.controller.ts");
    // order matters: the helper reads the founding admin, which only resolves once
    // autoProvisioned is cleared.
    expect(src.indexOf("autoProvisioned: false")).toBeLessThan(src.indexOf("await ensureLocalServer()"));
  });

  it("reset-admin-password registers too — the free-domain install lands there", async () => {
    const src = await readSrc("../../src/modules/system/setup.controller.ts");
    const reset = src.slice(src.indexOf("export async function resetAdminPassword"));
    expect(reset).toContain("ensureLocalServer()");
  });

  it("cloud-connect registers on both branches — the earliest point a free install can", async () => {
    const src = await readSrc("../../src/modules/system/self-app.controller.ts");
    const connect = src.slice(
      src.indexOf("export async function cloudConnect"),
      src.indexOf("export async function selfRegister"),
    );
    expect(connect.match(/ensureLocalServer\(\)/g)).toHaveLength(2);
  });

  it("GET /servers self-heals, so no install order can show an empty list", async () => {
    const src = await readSrc("../../src/modules/system/servers.controller.ts");
    const list = src.slice(src.indexOf("export async function listServers"));
    expect(list.indexOf("ensureLocalServer()")).toBeLessThan(list.indexOf("listByOrganization"));
  });

  it("createServer adopts through the primitive — no second creation site", async () => {
    const src = await readSrc("../../src/modules/system/servers.controller.ts");
    expect(src).not.toContain("isLocal: true");
    expect(src).toContain("ensureLocalServer({ name:");
  });
});
