import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveRecords = vi.hoisted(() => vi.fn());
const resolveProjectServerHost = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/dns-resolver", () => ({
  resolveRecords,
}));

vi.mock("../../../src/lib/server-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/server-target")>();
  return {
    ...actual,
    resolveProjectServerHost,
    resolveLocalServerHost: vi.fn().mockResolvedValue("203.0.113.10"),
    resolveInstancePublicIp: vi.fn().mockResolvedValue("203.0.113.10"),
  };
});

vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return {
    ...actual,
    platform: () => ({ target: "local", runtime: {} }),
  };
});

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: vi.fn().mockResolvedValue(undefined) },
  },
}));

import {
  checkRecords,
  dnsValueMatches,
  normalizeDnsValue,
} from "../../../src/modules/domains/domain.service";

describe("normalizeDnsValue / dnsValueMatches", () => {
  it("strips trailing dots and wrapping quotes", () => {
    expect(normalizeDnsValue(' "Edge.example.com." ')).toBe("edge.example.com");
  });

  it("matches CNAMEs that differ only by a trailing dot", () => {
    expect(dnsValueMatches("cname.openship.io", ["cname.openship.io."])).toBe(true);
  });

  it("treats an empty expected value as 'any observed record is enough'", () => {
    expect(dnsValueMatches("", ["203.0.113.10"])).toBe(true);
    expect(dnsValueMatches("", [])).toBe(false);
  });
});

describe("checkRecords — live DNS probe without creating a domain", () => {
  beforeEach(() => {
    resolveRecords.mockReset();
    resolveProjectServerHost.mockReset();
    resolveProjectServerHost.mockResolvedValue("203.0.113.10");
  });

  it("marks the A record ok when it already points at the server", async () => {
    resolveRecords.mockImplementation(async (name: string, type: string) => {
      if (type === "A" && name === "app.example.com") return ["203.0.113.10"];
      return [];
    });

    const result = await checkRecords("app.example.com");
    expect(result.mode).toBe("selfhosted");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      type: "A",
      name: "app.example.com",
      value: "203.0.113.10",
      status: "ok",
      observed: ["203.0.113.10"],
    });
    expect(result.allOk).toBe(true);
  });

  it("marks the A record missing when nothing resolves", async () => {
    resolveRecords.mockResolvedValue([]);
    const result = await checkRecords("app.example.com");
    expect(result.records[0]?.status).toBe("missing");
    expect(result.allOk).toBe(false);
  });

  it("marks the A record mismatch when it points elsewhere", async () => {
    resolveRecords.mockResolvedValue(["198.51.100.9"]);
    const result = await checkRecords("app.example.com");
    expect(result.records[0]?.status).toBe("mismatch");
    expect(result.records[0]?.observed).toEqual(["198.51.100.9"]);
    expect(result.allOk).toBe(false);
  });

  it("includes a www A record when includeWww is set", async () => {
    resolveRecords.mockResolvedValue([]);
    const result = await checkRecords("app.example.com", { includeWww: true });
    expect(result.records.map((row) => row.name)).toEqual([
      "app.example.com",
      "www.app.example.com",
    ]);
  });
});
