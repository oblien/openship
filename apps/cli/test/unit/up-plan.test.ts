import { afterEach, describe, expect, it } from "vitest";

import { planMethod, renderUpPlan, type UpPlan } from "../../src/lib/up-plan";

const realPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}
afterEach(() => setPlatform(realPlatform));

describe("planMethod", () => {
  // The decision `openship up` itself makes (it calls this with a real
  // ensureDocker result), so a preview can never name a method the run wouldn't
  // pick — which is the whole point of sharing it.
  it("takes --bare over everything, without consulting Docker", () => {
    setPlatform("linux");
    expect(planMethod({ bare: true }, true).method).toBe("bare");
    expect(planMethod({ bare: true }, false).method).toBe("bare");
  });

  it("honours --compose even when Docker isn't usable (the run fails loudly)", () => {
    setPlatform("linux");
    expect(planMethod({ compose: true }, false).method).toBe("compose");
  });

  it("defaults to compose on Linux only when Docker is usable", () => {
    setPlatform("linux");
    expect(planMethod({}, true).method).toBe("compose");
    expect(planMethod({}, false).method).toBe("bare");
  });

  it("never defaults to compose off Linux (the edge needs host networking)", () => {
    for (const platform of ["darwin", "win32"] as NodeJS.Platform[]) {
      setPlatform(platform);
      expect(planMethod({}, true).method).toBe("bare");
    }
  });
});

function basePlan(overrides: Partial<UpPlan> = {}): UpPlan {
  return {
    mode: "service",
    method: "compose",
    methodReason: "the default on Linux when Docker is usable",
    docker: { state: { binary: false, plugin: false, daemon: false }, gap: null, wouldInstall: false },
    ports: {
      api: 4000,
      dashboard: 3001,
      switched: { api: false, dashboard: false },
      preferred: { api: 4000, dashboard: 3001 },
    },
    writes: [],
    runs: [],
    ...overrides,
  };
}

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

describe("renderUpPlan", () => {
  it("leads with the fact that nothing changed", () => {
    expect(strip(renderUpPlan(basePlan()))).toContain("nothing on this machine has been changed");
  });

  // #436: the preview used to run the Docker install and then print a unit file,
  // so the plan has to SAY that an install is pending instead of performing it.
  it("reports a pending Docker install as part of the plan, with the command", () => {
    const out = strip(
      renderUpPlan(
        basePlan({
          docker: {
            state: { binary: false, plugin: false, daemon: false },
            gap: { summary: "Docker isn't installed", installable: true },
            wouldInstall: true,
            installCommand: "curl -fsSL https://get.docker.com | sh",
          },
        }),
      ),
    );
    expect(out).toContain("Docker isn't installed");
    expect(out).toMatch(/WOULD install it/);
    expect(out).toContain("curl -fsSL https://get.docker.com | sh");
    // The escape hatch for an operator who doesn't want Docker on this box.
    expect(out).toContain("--bare");
  });

  it("says nothing would be installed when Docker is already usable", () => {
    const out = strip(renderUpPlan(basePlan()));
    expect(out).toContain("already installed and usable");
    expect(out).not.toMatch(/WOULD install/);
  });

  it("does not claim an install when Docker is present but unreachable", () => {
    const out = strip(
      renderUpPlan(
        basePlan({
          docker: {
            state: { binary: true, plugin: true, daemon: false },
            gap: {
              summary: "Docker is installed but its daemon isn't reachable",
              installable: false,
              hint: "sudo systemctl start docker",
            },
            wouldInstall: false,
          },
        }),
      ),
    );
    expect(out).toContain("would NOT install it");
    expect(out).toContain("sudo systemctl start docker");
  });

  it("prints the service definition for the bare method", () => {
    const out = strip(
      renderUpPlan(
        basePlan({
          method: "bare",
          service: {
            kind: "systemd-user",
            path: "/home/u/.config/systemd/user/openship.service",
            content: "[Service]\nExecStart=/usr/bin/node up --foreground\n",
          },
          writes: ["/home/u/.config/systemd/user/openship.service"],
          runs: ["systemctl --user enable --now  (starts it now and on boot)"],
        }),
      ),
    );
    expect(out).toContain("/home/u/.config/systemd/user/openship.service");
    expect(out).toContain("ExecStart=/usr/bin/node up --foreground");
    expect(out).toContain("systemctl --user enable --now");
  });

  it("names the proxy on 80/443 and the choice a real run would offer", () => {
    const out = strip(
      renderUpPlan(
        basePlan({
          edge: {
            owner: "nginx.service",
            blocked: true,
            sites: [
              { serverNames: ["a.com"], ssl: true, target: { kind: "proxy", url: "http://127.0.0.1:3000" } },
              { serverNames: ["b.com"], ssl: false, target: { kind: "proxy", url: "http://127.0.0.1:3001" } },
            ],
            warnings: [],
          },
        }),
      ),
    );
    expect(out).toContain("held by nginx.service");
    expect(out).toMatch(/would ask before/);
    expect(out).toContain("a.com");
    expect(out).toContain("b.com");
  });

  it("flags a preferred port that's busy right now", () => {
    const out = strip(
      renderUpPlan(
        basePlan({
          ports: {
            api: 4001,
            dashboard: 3002,
            switched: { api: true, dashboard: true },
            preferred: { api: 4000, dashboard: 3001 },
          },
        }),
      ),
    );
    expect(out).toContain("API 4001");
    expect(out).toMatch(/preferred 4000\/3001/);
  });
});
