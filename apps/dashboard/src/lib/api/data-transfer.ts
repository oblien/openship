import { api, getApiBaseUrl } from "./client";
import { endpoints } from "./endpoints";

/**
 * Whole-instance data export / import API client. Talks to the routes under
 * /api/system/data-transfer. Self-hosted + owner-only on the API side.
 *
 * Whole-DB moves are slow, so both calls override the default 15s timeout.
 */

export type ImportMode = "wipe" | "merge";
export type ExportHistoryCategory =
  | "analytics"
  | "activity"
  | "backups"
  | "incidents"
  | "migrations";

export interface ExportPreview {
  core: number;
  history: Record<ExportHistoryCategory, number>;
  total: number;
}

/** Opaque export file — the dashboard treats it as a JSON blob to download. */
export type DataTransferFile = Record<string, unknown>;

export interface ImportResult {
  mode: ImportMode;
  rowsRestored: number;
  secretsRehydrated: number;
  secretsSkipped: boolean;
  /** Imported projects whose source is a local folder path from the SOURCE
   *  machine — that path won't exist here (e.g. a Mac path on a Linux server), so
   *  re-point or re-deploy before their next deploy. Empty when nothing needs it. */
  localPathProjects: Array<{ slug: string; localPath: string }>;
}

export interface DirectReceiveSession {
  code: string;
  expiresAt: string;
  mode: ImportMode;
}

export interface DirectTransferResult extends ImportResult {
  destination: string;
}

export interface DirectCodeInfo {
  destination: string;
  mode: ImportMode;
  expiresAt: string;
}

/** Display-only decoding; the API performs the authoritative validation. */
export function inspectDirectTransferCode(code: string): DirectCodeInfo | null {
  try {
    const normalized = code.trim().replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as Record<string, unknown>;
    if (
      typeof parsed.apiBase !== "string" ||
      (parsed.mode !== "wipe" && parsed.mode !== "merge") ||
      typeof parsed.expiresAt !== "string"
    ) return null;
    return {
      destination: new URL(parsed.apiBase).origin,
      mode: parsed.mode,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

const LONG_TIMEOUT = 600_000;

export const dataTransferApi = {
  preview: () =>
    api.get<ExportPreview>(endpoints.system.dataTransfer.preview),

  createDirectReceiveSession: (mode: ImportMode) =>
    api.post<DirectReceiveSession>(endpoints.system.dataTransfer.directSession, {
      apiBase: getApiBaseUrl(),
      mode,
    }),

  sendDirect: (code: string, history?: ExportHistoryCategory[]) =>
    api.post<DirectTransferResult>(
      endpoints.system.dataTransfer.directSend,
      { code, ...(history ? { selection: { history } } : {}) },
      { timeout: LONG_TIMEOUT },
    ),

  export: (passphrase?: string, history?: ExportHistoryCategory[]) =>
    api.post<DataTransferFile>(
      endpoints.system.dataTransfer.export,
      { passphrase, ...(history ? { selection: { history } } : {}) },
      { timeout: LONG_TIMEOUT },
    ),

  import: (file: DataTransferFile, passphrase: string | undefined, mode: ImportMode) =>
    api.post<ImportResult>(
      endpoints.system.dataTransfer.import,
      { file, passphrase, mode },
      { timeout: LONG_TIMEOUT },
    ),
};
