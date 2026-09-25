import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { shellQuote } from "@repo/core";
import { renderServiceDiscoveryScript } from "./service-discovery";
import { CloudComposeSupport } from "./compose";

describe("cloud service discovery shell boundary", () => {
  it.each(["web\nEOF\nprintf injected\n#", "$(id)", "web;id", "x'quote"])("rejects hostile names before deployment and discovery: %s", async serviceName => {
    expect(() => renderServiceDiscoveryScript("compose-demo", [{ serviceName, ip: "10.0.0.2" }])).toThrow();
    const support = new CloudComposeSupport({} as never);
    await expect(support.deployServiceWorkload({ id: "demo" } as never, { serviceName } as never)).rejects.toThrow("Invalid service name");
  });
  it("refuses unsafe group and address data from saved state", () => {
    expect(() => renderServiceDiscoveryScript("group'\nid", [{ serviceName: "web", ip: "10.0.0.2" }])).toThrow();
    expect(() => renderServiceDiscoveryScript("group", [{ serviceName: "web", ip: "10.0.0.2\nEOF\nid" }])).toThrow();
  });
  it("updates only its own hosts entries and can safely run again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-discovery-"));
    try {
      const hosts = join(dir, "hosts");
      await writeFile(hosts, "127.0.0.1 localhost\n10.0.0.1 old # openship-compose:demo\n10.0.0.9 other # openship-compose:demo2\n");
      const script = renderServiceDiscoveryScript("demo", [{ serviceName: "api", ip: "10.0.0.2" }, { serviceName: "db", ip: "10.0.0.3" }])
        .replaceAll("/etc/hosts", shellQuote(hosts));
      execFileSync("sh", ["-c", script]);
      execFileSync("sh", ["-c", script]);
      expect(await readFile(hosts, "utf8")).toBe("127.0.0.1 localhost\n10.0.0.9 other # openship-compose:demo2\n10.0.0.2 api # openship-compose:demo\n10.0.0.3 db # openship-compose:demo\n");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
