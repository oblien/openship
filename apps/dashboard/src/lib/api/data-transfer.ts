import { api } from "./client";
import { endpoints } from "./endpoints";

/**
 * Whole-instance data export / import API client. Talks to the routes under
 * /api/system/data-transfer. Self-hosted + owner-only on the API side.
 *
 * Whole-DB moves are slow, so both calls override the default 15s timeout.
 */

export type ImportMode = "wipe" | "merge";

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

const LONG_TIMEOUT = 600_000;

export const dataTransferApi = {
  export: (passphrase?: string) =>
    api.post<DataTransferFile>(
      endpoints.system.dataTransfer.export,
      { passphrase },
      { timeout: LONG_TIMEOUT },
    ),

  import: (file: DataTransferFile, passphrase: string | undefined, mode: ImportMode) =>
    api.post<ImportResult>(
      endpoints.system.dataTransfer.import,
      { file, passphrase, mode },
      { timeout: LONG_TIMEOUT },
    ),
};
