import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
  it("migrates the existing desktop cookie jar into a Main profile", () => {
    const profiles = store();
    expect(profiles.active()).toMatchObject({ id: "main", name: "Main", partition: null });
  });

  it("creates persistent named profiles without treating names as emails", () => {
    const profiles = store();
    const backup = profiles.create(" Main_Backup ");
    expect(backup.name).toBe("Main_Backup");
    expect(backup.partition).toBe(`persist:openship-profile-${backup.id}`);
    expect(backup.needsSignIn).toBe(true);
  });

  it("rejects ambiguous duplicate labels and protects the active profile", () => {
    const profiles = store();
    const backup = profiles.create("Main_Backup");
    expect(() => profiles.create("main_backup")).toThrow("already exists");
    profiles.setActive(backup.id);
    expect(() => profiles.remove(backup.id)).toThrow("Switch profiles");
  });
});
