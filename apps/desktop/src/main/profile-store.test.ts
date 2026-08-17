import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopProfileStore } from "./profile-store";

const directories: string[] = [];

function store(): DesktopProfileStore {
  const directory = mkdtempSync(join(tmpdir(), "openship-profiles-"));
  directories.push(directory);
  return new DesktopProfileStore(directory);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DesktopProfileStore", () => {
  it("migrates the existing desktop cookie jar into a Default browser session", () => {
    const profiles = store();
    expect(profiles.active()).toMatchObject({ id: "main", name: "Default", partition: null });
  });

  it("renames a stored Main session to Default without splitting the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "openship-profiles-"));
    directories.push(directory);
    writeFileSync(
      join(directory, "profiles.json"),
      JSON.stringify({
        version: 1,
        activeProfileId: "main",
        profiles: [
          {
            id: "main",
            name: "Main",
            partition: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const profiles = new DesktopProfileStore(directory);
    expect(profiles.active().name).toBe("Default");
  });

  it("creates persistent named sessions without treating names as emails", () => {
    const profiles = store();
    const backup = profiles.create(" Main_Backup ");
    expect(backup.name).toBe("Main_Backup");
    expect(backup.partition).toBe(`persist:openship-profile-${backup.id}`);
    expect(backup).not.toHaveProperty("needsSignIn");
  });

  it("rejects ambiguous duplicate labels and protects the active session", () => {
    const profiles = store();
    const backup = profiles.create("Main_Backup");
    expect(() => profiles.create("main_backup")).toThrow("already exists");
    profiles.setActive(backup.id);
    expect(() => profiles.remove(backup.id)).toThrow("Switch sessions");
  });

  it("writes profiles.json atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "openship-profiles-"));
    directories.push(directory);
    const profiles = new DesktopProfileStore(directory);
    profiles.create("Work");
    const files = readdirSync(directory);
    expect(files).toContain("profiles.json");
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, "profiles.json"), "utf-8")).profiles).toHaveLength(2);
  });
});
