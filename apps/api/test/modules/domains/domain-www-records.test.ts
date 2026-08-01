import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Include www" claims a SECOND hostname, so the DNS Records panel has to show
 * ITS record too. It didn't: `previewRecords` was called with only the hostname,
 * `includeWww` was never threaded, and the effect didn't even depend on the
 * toggle — so the user turned www on, saw a lone apex record, and had no idea why
 * www never resolved.
 */

const domainRepo = vi.hoisted(() => ({
  create: vi.fn(),
  findByHostname: vi.fn(),
  setPrimary: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: { domain: domainRepo, project: { findById: vi.fn() } },
  normalizeRoutingFields: vi.fn(),
}));

let platformTarget: "local" | "cloud" = "local";
const cloudVerifyDomain = vi.fn();

vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return {
    ...actual,
    platform: () => ({
      target: platformTarget,
      runtime: { verifyDomain: cloudVerifyDomain },
    }),
  };
});

vi.mock("../../../src/lib/server-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/server-target")>();
  return {
    ...actual,
    resolveProjectServerHost: vi.fn().mockResolvedValue("203.0.113.10"),
    resolveLocalServerHost: vi.fn().mockResolvedValue("203.0.113.10"),
    resolveInstancePublicIp: vi.fn().mockResolvedValue("203.0.113.10"),
  };
});

const { previewRecords } = await import("../../../src/modules/domains/domain.service");

beforeEach(() => {
  vi.clearAllMocks();
  platformTarget = "local";
  cloudVerifyDomain.mockResolvedValue({
    requiredRecords: { cname: { target: "edge.opsh.io" } },
  });
});

describe("previewRecords — self-hosted", () => {
  it("returns only the apex A record when www is off", async () => {
    const { mode, records } = await previewRecords("freshs.hekai.org", "org_1", false);
    expect(mode).toBe("selfhosted");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "A", host: "freshs", name: "freshs.hekai.org" });
  });

  it("adds the www A record when the toggle is on", async () => {
    const { records } = await previewRecords("freshs.hekai.org", "org_1", true);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      type: "A",
      host: "www.freshs",
      name: "www.freshs.hekai.org",
    });
    // Same box → same value, so both rows point at the server.
    expect(records[1]!.value).toBe(records[0]!.value);
  });

  it("uses @ / www for an apex domain", async () => {
    const { records } = await previewRecords("hekai.org", "org_1", true);
    expect(records.map((r) => r.host)).toEqual(["@", "www"]);
    expect(records.map((r) => r.name)).toEqual(["hekai.org", "www.hekai.org"]);
  });

  // Guards the "never stacks www on www" rule the add path already enforces.
  it("does not stack www on a hostname that is already www", async () => {
    const { records } = await previewRecords("www.hekai.org", "org_1", true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: "www.hekai.org" });
  });
});

describe("previewRecords — cloud", () => {
  it("returns the apex CNAME + ownership TXT when www is off", async () => {
    platformTarget = "cloud";
    const { mode, records } = await previewRecords("freshs.hekai.org", "org_1", false);
    expect(mode).toBe("cloud");
    expect(records.map((r) => r.type)).toEqual(["CNAME", "TXT"]);
  });

  it("adds a CNAME AND its own TXT for www (the shared edge verifies each name)", async () => {
    platformTarget = "cloud";
    const { records } = await previewRecords("freshs.hekai.org", "org_1", true);
    expect(records.map((r) => r.type)).toEqual(["CNAME", "TXT", "CNAME", "TXT"]);
    expect(records[2]).toMatchObject({ name: "www.freshs.hekai.org", value: "edge.opsh.io" });
    expect(records[3]).toMatchObject({
      type: "TXT",
      name: "_openship-challenge.www.freshs.hekai.org",
    });
    // Each hostname proves ownership with its OWN token.
    expect(records[3]!.value).not.toBe(records[1]!.value);
  });
});
