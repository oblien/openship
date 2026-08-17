import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-json";

export interface DesktopProfile {
  id: string;
  name: string;
  /**
   * Electron session partition. Cookie jar + renderer storage only.
   * Every session shares the one PGlite control-plane database.
   */
  partition: string | null;
  createdAt: string;
  lastUsedAt: string;
}

interface ProfileFile {
  version: 1;
  activeProfileId: string;
  profiles: DesktopProfile[];
}

const MAIN_PROFILE_ID = "main";
const MAX_PROFILE_NAME = 40;

function now(): string {
  return new Date().toISOString();
}

function initialFile(): ProfileFile {
  const createdAt = now();
  return {
    version: 1,
    activeProfileId: MAIN_PROFILE_ID,
    profiles: [
      {
        id: MAIN_PROFILE_ID,
        name: "Default",
        partition: null,
        createdAt,
        lastUsedAt: createdAt,
      },
    ],
  };
}

function normalizedName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Session name is required");
  if (name.length > MAX_PROFILE_NAME) {
    throw new Error(`Session name must be ${MAX_PROFILE_NAME} characters or fewer`);
  }
  return name;
}

export class DesktopProfileStore {
  private readonly filePath: string;
  private data: ProfileFile;

  constructor(userDataPath: string) {
    mkdirSync(userDataPath, { recursive: true });
    this.filePath = join(userDataPath, "profiles.json");
    this.data = this.read();
    this.save();
  }

  list(): DesktopProfile[] {
    return this.data.profiles.map((profile) => ({ ...profile }));
  }

  active(): DesktopProfile {
    return this.find(this.data.activeProfileId);
  }

  create(value: string): DesktopProfile {
    const name = normalizedName(value);
    this.assertUniqueName(name);
    const id = `profile_${randomBytes(8).toString("hex")}`;
    const createdAt = now();
    const profile: DesktopProfile = {
      id,
      name,
      partition: `persist:openship-profile-${id}`,
      createdAt,
      lastUsedAt: createdAt,
    };
    this.data.profiles.push(profile);
    this.save();
    return { ...profile };
  }

  rename(id: string, value: string): DesktopProfile {
    const name = normalizedName(value);
    this.assertUniqueName(name, id);
    const profile = this.find(id);
    profile.name = name;
    this.save();
    return { ...profile };
  }

  setActive(id: string): DesktopProfile {
    const profile = this.find(id);
    profile.lastUsedAt = now();
    this.data.activeProfileId = id;
    this.save();
    return { ...profile };
  }

  remove(id: string): DesktopProfile {
    if (this.data.profiles.length === 1) {
      throw new Error("Keep at least one browser session");
    }
    if (id === this.data.activeProfileId) {
      throw new Error("Switch sessions before removing the active session");
    }
    const profile = this.find(id);
    this.data.profiles = this.data.profiles.filter((entry) => entry.id !== id);
    this.save();
    return { ...profile };
  }

  private read(): ProfileFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<ProfileFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.profiles) || !parsed.profiles.length) {
        return initialFile();
      }
      const profiles = parsed.profiles.filter(
        (profile): profile is DesktopProfile =>
          !!profile && typeof profile.id === "string" && typeof profile.name === "string",
      );
      if (!profiles.length) return initialFile();
      for (const profile of profiles) {
        if (profile.id === MAIN_PROFILE_ID && profile.name === "Main") {
          profile.name = "Default";
        }
      }
      const activeProfileId = profiles.some((profile) => profile.id === parsed.activeProfileId)
        ? parsed.activeProfileId!
        : profiles[0].id;
      return { version: 1, activeProfileId, profiles };
    } catch {
      return initialFile();
    }
  }

  private find(id: string): DesktopProfile {
    const profile = this.data.profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error("Browser session not found");
    return profile;
  }

  private assertUniqueName(name: string, exceptId?: string): void {
    const duplicate = this.data.profiles.some(
      (profile) =>
        profile.id !== exceptId && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (duplicate) throw new Error("A browser session with that name already exists");
  }

  private save(): void {
    writeJsonAtomic(this.filePath, this.data);
  }
}
