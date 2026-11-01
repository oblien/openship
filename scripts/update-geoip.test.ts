import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reader } from "maxmind";
import { parse } from "yaml";
import { inspectGeoip, refreshGeoip } from "./update-geoip.mjs";

const bytes = readFileSync(new URL("../apps/api/assets/geoip/GeoLite2-Country.mmdb", import.meta.url));
const built = new Reader(bytes).metadata.buildEpoch.getTime();
const day = 86_400_000;
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe("release GeoIP snapshot", () => {
  it("gates both publishing workflows without mutating tagged build inputs", () => {
    const workflow = (name: string) => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
    const geoip = workflow("geoip");
    expect(geoip.on.workflow_dispatch.inputs.refresh.default).toBe(true);
    expect(geoip.on.workflow_call.inputs.refresh.default).toBe(false);
    expect(workflow("release-gate").jobs.geoip.uses).toBe("./.github/workflows/geoip.yml");
    expect(workflow("release").jobs.publish.needs).toContain("gate");
    expect(workflow("docker-images").jobs["merge-images"].needs).toContain("gate");
  });
  it("accepts a recent country database and records its content hash", () => {
    const receipt = inspectGeoip(bytes, built + 7 * day);
    expect(receipt.databaseType).toBe("GeoLite2-Country");
    expect(receipt.ageDays).toBe(7);
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.bytes).toBe(bytes.length);
  });

  it("rejects stale, future, malformed and non-country snapshots", () => {
    expect(() => inspectGeoip(bytes, built + 15 * day)).toThrow("not current");
    expect(() => inspectGeoip(bytes, built - 2 * day)).toThrow("not current");
    expect(() => inspectGeoip(Buffer.from("not a database"))).toThrow();
    expect(() => inspectGeoip(Buffer.alloc(1_000_001))).toThrow();
    const other = Buffer.from(bytes);
    const offset = other.lastIndexOf(Buffer.from("GeoLite2-Country"));
    expect(offset).toBeGreaterThan(0);
    other.write("GeoLite2-Unknown", offset);
    expect(() => inspectGeoip(other, built)).toThrow("Unexpected GeoIP database type");
  });

  it("preserves the packaged copy until a download passes validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geoip-release-"));
    temporary.push(dir);
    const destination = join(dir, "country.mmdb");
    writeFileSync(destination, "previous snapshot");
    let status = 503;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes, { status }) });
    try {
      await expect(refreshGeoip(server.url.href, destination, built)).rejects.toThrow("HTTP 503");
      expect(readFileSync(destination, "utf8")).toBe("previous snapshot");
      status = 200;
      await expect(refreshGeoip(server.url.href, destination, built + 15 * day)).rejects.toThrow("not current");
      expect(readFileSync(destination, "utf8")).toBe("previous snapshot");
      await refreshGeoip(server.url.href, destination, built + day);
      expect(readFileSync(destination).equals(bytes)).toBe(true);
    } finally { await server.stop(true); }
  });
});
