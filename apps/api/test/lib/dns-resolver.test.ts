import { afterEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";
import { resolveRecords } from "@repo/platform/engine/lib/dns-resolver";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("DNS TXT verification sources", () => {
  it("decodes quoted chunks within one record and excludes CNAME answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Answer: [
      { type: 5, data: "other.example.com." },
      { type: 16, data: '"first" "second"' },
      { type: 16, data: '"separate"' },
      { type: 16, data: "raw-token" },
    ] }) }));
    expect(await resolveRecords("_openship-challenge.app.example.com", "TXT"))
      .toEqual(["firstsecond", "separate", "raw-token"]);
  });

  it("joins the chunks of a local TXT record without joining separate records", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("DoH unavailable")));
    vi.spyOn(dns, "resolveTxt").mockResolvedValue([["first", "second"], ["separate"]]);
    expect(await resolveRecords("_openship-challenge.app.example.com", "TXT"))
      .toEqual(["firstsecond", "separate"]);
  });

  it("does not accept an unrelated record type as an ownership token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Answer: [
      { type: 5, data: "token" },
    ] }) }));
    expect(await resolveRecords("_openship-challenge.app.example.com", "TXT")).toEqual([]);
  });
});
