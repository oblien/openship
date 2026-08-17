import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopControlPlaneState } from "./control-plane-state";

const directories: string[] = [];

function state(): DesktopControlPlaneState {
  const directory = mkdtempSync(join(tmpdir(), "openship-plane-"));
  directories.push(directory);
  return new DesktopControlPlaneState(directory);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DesktopControlPlaneState", () => {
  it("mints a stable fingerprint across reloads", () => {
    const first = state();
    const second = new DesktopControlPlaneState(first.userDataPath);
    expect(first.fingerprint).toMatch(/^os_[0-9a-f]{16}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("persists advertised origin and remembers the previous one when it moves", () => {
    const plane = state();
    plane.recordResolved({
      api: 54777,
      dashboard: 54778,
      advertisedOrigin: "http://127.0.0.1:54777",
      preferred: { api: 54777, dashboard: 54778 },
      switched: { api: false, dashboard: false },
    });
    plane.recordResolved({
      api: 54801,
      dashboard: 54778,
      advertisedOrigin: "http://127.0.0.1:54801",
      preferred: { api: 54777, dashboard: 54778 },
      switched: { api: true, dashboard: false },
    });
    const snap = plane.snapshot({
      api: "http://127.0.0.1:54801",
      dashboard: "http://127.0.0.1:54778",
    });
    expect(snap.advertisedOrigin).toBe("http://127.0.0.1:54801");
    expect(snap.previousAdvertisedOrigin).toBe("http://127.0.0.1:54777");
    expect(snap.switched).toEqual({ api: true, dashboard: false });
    expect(plane.preferredPorts()).toEqual({ api: 54777, dashboard: 54778 });
  });

  it("writes ports.json atomically and reloads stored ports", () => {
    const plane = state();
    writeFileSync(join(plane.userDataPath, "ports.json"), "{");
    plane.recordResolved({
      api: 40010,
      dashboard: 40011,
      advertisedOrigin: "http://127.0.0.1:40010",
      preferred: { api: 40010, dashboard: 40011 },
      switched: { api: false, dashboard: false },
    });
    const parsed = JSON.parse(readFileSync(join(plane.userDataPath, "ports.json"), "utf-8"));
    expect(parsed.api).toBe(40010);
    expect(parsed.advertisedOrigin).toBe("http://127.0.0.1:40010");
    expect(readdirSync(plane.userDataPath).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const reloaded = new DesktopControlPlaneState(plane.userDataPath);
    expect(reloaded.loadStoredPorts()).toEqual({ api: 40010, dashboard: 40011 });
    expect(reloaded.lastAdvertisedOrigin()).toBe("http://127.0.0.1:40010");
  });
});
