import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-json";

export interface StoredPortsFile {
  api?: number;
  dashboard?: number;
  advertisedOrigin?: string;
  preferred?: { api?: number; dashboard?: number };
  switched?: { api: boolean; dashboard: boolean };
}

export interface ControlPlaneSnapshot {
  api: string;
  dashboard: string;
  advertisedOrigin: string;
  previousAdvertisedOrigin: string | null;
  switched: { api: boolean; dashboard: boolean };
  fingerprint: string;
  dataPath: string;
  userDataPath: string;
}

interface InstanceFile {
  fingerprint: string;
}

export class DesktopControlPlaneState {
  readonly userDataPath: string;
  readonly dataPath: string;
  readonly fingerprint: string;

  private readonly instanceFile: string;
  private readonly portsFilePath: string;
  private ports: StoredPortsFile;
  private previousAdvertisedOrigin: string | null;

  constructor(userDataPath: string) {
    mkdirSync(userDataPath, { recursive: true });
    this.userDataPath = userDataPath;
    this.dataPath = join(userDataPath, "data");
    mkdirSync(this.dataPath, { recursive: true });
    this.instanceFile = join(userDataPath, "instance.json");
    this.portsFilePath = join(userDataPath, "ports.json");
    this.fingerprint = this.loadOrCreateFingerprint();
    this.ports = this.readPorts();
    this.previousAdvertisedOrigin = this.ports.advertisedOrigin ?? null;
  }

  loadStoredPorts(): { api?: number; dashboard?: number } {
    return { api: this.ports.api, dashboard: this.ports.dashboard };
  }

  preferredPorts(): { api?: number; dashboard?: number } {
    return this.ports.preferred ?? this.loadStoredPorts();
  }

  lastAdvertisedOrigin(): string | null {
    return this.ports.advertisedOrigin ?? null;
  }

  recordResolved(input: {
    api: number;
    dashboard: number;
    advertisedOrigin: string;
    preferred: { api: number; dashboard: number };
    switched: { api: boolean; dashboard: boolean };
  }): void {
    this.previousAdvertisedOrigin = this.ports.advertisedOrigin ?? null;
    this.ports = {
      api: input.api,
      dashboard: input.dashboard,
      advertisedOrigin: input.advertisedOrigin,
      preferred: input.preferred,
      switched: input.switched,
    };
    writeJsonAtomic(this.portsFilePath, this.ports);
  }

  snapshot(urls: { api: string; dashboard: string }): ControlPlaneSnapshot {
    return {
      api: urls.api,
      dashboard: urls.dashboard,
      advertisedOrigin: this.ports.advertisedOrigin ?? urls.api,
      previousAdvertisedOrigin: this.previousAdvertisedOrigin,
      switched: this.ports.switched ?? { api: false, dashboard: false },
      fingerprint: this.fingerprint,
      dataPath: this.dataPath,
      userDataPath: this.userDataPath,
    };
  }

  private loadOrCreateFingerprint(): string {
    try {
      const parsed = JSON.parse(readFileSync(this.instanceFile, "utf-8")) as Partial<InstanceFile>;
      if (typeof parsed.fingerprint === "string" && parsed.fingerprint.trim()) {
        return parsed.fingerprint.trim();
      }
    } catch {
      // first launch
    }
    const fingerprint = `os_${randomBytes(8).toString("hex")}`;
    writeJsonAtomic(this.instanceFile, { fingerprint } satisfies InstanceFile);
    return fingerprint;
  }

  private readPorts(): StoredPortsFile {
    try {
      const parsed = JSON.parse(readFileSync(this.portsFilePath, "utf-8")) as StoredPortsFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
}
