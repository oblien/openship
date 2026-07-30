import "../modules/mail/_setup-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "This Server" registration is owned by the founding admin's org, so it can't
 * happen before that admin exists. A CLI install creates the admin AFTER the API
 * has already booted, so a boot-only hook bailed and never retried — the box
 * showed "No servers yet" while Openship itself sat in the Apps tab. These pin
 * both halves: the bail is correct, and the bootstrap-admin call closes the window.
 */

const serverRepo = vi.hoisted(() => ({ findLocal: vi.fn(), create: vi.fn() }));
const foundingAdminId = vi.hoisted(() => vi.fn());
const hostControlDisabled = vi.hoisted(() => vi.fn(() => false));

vi.mock("@repo/db", () => ({ repos: { server: serverRepo } }));
vi.mock("../../src/modules/system/self-app.controller", () => ({ foundingAdminId }));
vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return { ...actual, hostControlDisabled };
});

import { ensureLocalServerRegistered } from "../../src/lib/startup/self-server";

beforeEach(() => {
  vi.clearAllMocks();
  hostControlDisabled.mockReturnValue(false);
  serverRepo.findLocal.mockResolvedValue(null);
  foundingAdminId.mockResolvedValue("usr_1");
});

afterEach(() => {
  delete process.env.SERVER_IP;
});

describe("ensureLocalServerRegistered", () => {
  it("registers the host in the founding admin's org", async () => {
    expect(await ensureLocalServerRegistered()).toBe(true);
    expect(serverRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org_usr_1", name: "This Server", isLocal: true }),
    );
  });

  // The boot-order case: no admin at boot → bail, then the SAME call succeeds once
  // bootstrap-admin has run. This is exactly the sequence a CLI install produces.
  it("bails with no admin, then registers on the retry after bootstrap-admin", async () => {
    foundingAdminId.mockResolvedValue(null);
    expect(await ensureLocalServerRegistered()).toBe(false);
    expect(serverRepo.create).not.toHaveBeenCalled();

    foundingAdminId.mockResolvedValue("usr_1");
    expect(await ensureLocalServerRegistered()).toBe(true);
    expect(serverRepo.create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — never a second row", async () => {
    serverRepo.findLocal.mockResolvedValue({ id: "srv_1", isLocal: true });
    expect(await ensureLocalServerRegistered()).toBe(false);
    expect(serverRepo.create).not.toHaveBeenCalled();
  });

  it("does NOT advertise the host when host control is off", async () => {
    hostControlDisabled.mockReturnValue(true);
    expect(await ensureLocalServerRegistered()).toBe(false);
    expect(serverRepo.create).not.toHaveBeenCalled();
  });
});

describe("bootstrap-admin wiring", () => {
  // The fix is only load-bearing if bootstrap-admin actually calls it — a boot hook
  // alone cannot cover the install ordering.
  it("bootstrap-admin registers the local server after creating the admin", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../src/modules/system/setup.controller.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(src).toContain("ensureLocalServerRegistered");
    // …and after the admin row is written, not before (order matters: the helper
    // reads foundingAdminId, which only returns once autoProvisioned is cleared).
    expect(src.indexOf("autoProvisioned: false")).toBeLessThan(
      src.indexOf("await ensureLocalServerRegistered()"),
    );
  });
});
