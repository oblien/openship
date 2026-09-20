import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { baseDictionary as en } from "@/i18n";

/**
 * The routing banner must state the ACTUAL cause.
 *
 * `routingUnsynced` fires for any route/TLS sync failure — `deploymentRoutingUnsynced` reads
 * `edgeUnsynced || deployWarning`, and the compose pipeline sets both for ANY `routeIssuesWarning`,
 * including custom domains merely waiting on a certificate. The banner carried one hardcoded
 * sentence about a free `.opsh.io` URL failing to route through Openship Cloud's edge, and showed
 * it for every cause: a self-hosted project with three CUSTOM domains was told its free domain
 * hadn't routed through a cloud it doesn't use, and pointed at the wrong remedy — while the
 * accurate sentence sat unread in the same deployment meta blob.
 */
const src = readFileSync(new URL("./RoutingUnsyncedCallout.tsx", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the banner prefers the server's own reason", () => {
  it("renders routingWarning when present, generic copy only as fallback", () => {
    expect(code).toContain("projectData?.routingWarning || t.projects.routingRetry.description");
  });

  it("re-reads the project after a successful repair", () => {
    // The repair re-applies routes and re-checks what the edge SERVES, so per-domain
    // verification and SSL can all have moved. Patching one boolean left the cards stale.
    expect(code).toContain("invalidateProjectCaches");
  });

  it("still surfaces the server's reason on failure", () => {
    expect(code).toContain("res?.warning || res?.error");
  });
});

describe("the fallback copy names no single cause", () => {
  const r = en.projects.routingRetry as Record<string, string>;

  it("does not claim a free .opsh.io domain", () => {
    for (const [k, v] of Object.entries(r)) {
      expect(v, `routingRetry.${k}`).not.toMatch(/opsh\.io/i);
      expect(v, `routingRetry.${k}`).not.toMatch(/free domain|free \.?opsh/i);
    }
  });

  it("does not send a self-hosted operator to Openship Cloud", () => {
    // The old description did exactly that, for a project that may never touch the cloud.
    expect(r.description).not.toMatch(/Openship Cloud/i);
  });

  it("still offers a remedy", () => {
    expect(r.description).toMatch(/DNS|edge|Retry/i);
  });
});
