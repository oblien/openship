import { readSseTerminalEvent } from "@repo/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { api, ApiError, getActiveOrganizationId, getApiBaseUrl } from "./client";
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
    )
      return null;
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
const CHUNK_TIMEOUT = 120_000;
const TRANSFER_STREAM_TIMEOUT = 6 * 60 * 60_000;

interface ImportUploadSession {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  expiresAt: string;
}

interface ResumableImportUpload {
  session: ImportUploadSession;
  completedChunks: number;
}

// A failed finalize (most commonly a mistyped transfer secret) must not force
// the operator to upload the same large File again. Weak keys release the entry
// automatically when the picker/modal releases its File object.
const resumableImportUploads = new WeakMap<File, ResumableImportUpload>();

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = sha256(new Uint8Array(await blob.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uploadWithRetry(uploadId: string, index: number, chunk: Blob): Promise<void> {
  const digest = await sha256Hex(chunk);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await api.put(endpoints.system.dataTransfer.importChunk(uploadId, index), chunk, {
        timeout: CHUNK_TIMEOUT,
        headers: {
          "content-type": "application/octet-stream",
          "x-openship-chunk-sha256": digest,
        },
      });
      return;
    } catch (error) {
      lastError = error;
      if (
        error instanceof ApiError &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        throw error;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function postTransferStream<T>(path: string, body: unknown): Promise<T> {
  const headers = new Headers({
    accept: "text/event-stream",
    "content-type": "application/json",
  });
  const organizationId = getActiveOrganizationId();
  if (organizationId) headers.set("x-organization-id", organizationId);
  const response = await fetch(new URL(path, getApiBaseUrl()), {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TRANSFER_STREAM_TIMEOUT),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Keep the plain response for ApiError/getApiErrorMessage.
    }
    throw new ApiError(response.status, response.statusText, parsed);
  }
  if (
    !(response.headers.get("content-type") ?? "").includes("text/event-stream") ||
    !response.body
  ) {
    throw new Error("The data-transfer stream returned an invalid response.");
  }

  const terminal = await readSseTerminalEvent(response.body);
  if (terminal.event === "complete") return JSON.parse(terminal.data) as T;
  const failure = JSON.parse(terminal.data) as { status?: number; error?: string; code?: string };
  throw new ApiError(
    typeof failure.status === "number" ? failure.status : 500,
    "Data transfer failed",
    { error: failure.error, code: failure.code },
  );
}

export const dataTransferApi = {
  preview: () => api.get<ExportPreview>(endpoints.system.dataTransfer.preview),

  createDirectReceiveSession: (mode: ImportMode) =>
    api.post<DirectReceiveSession>(endpoints.system.dataTransfer.directSession, {
      apiBase: getApiBaseUrl(),
      mode,
    }),

  sendDirect: (code: string, history?: ExportHistoryCategory[]) =>
    postTransferStream<DirectTransferResult>(endpoints.system.dataTransfer.directSendStream, {
      code,
      ...(history ? { selection: { history } } : {}),
    }),

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

  /** Upload a local export in bounded pieces; the browser never materializes the
   * complete JSON document and every request stays below the edge body limit. */
  importFile: async (
    file: File,
    passphrase: string | undefined,
    mode: ImportMode,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<ImportResult> => {
    let lastError: unknown;
    for (let sessionAttempt = 0; sessionAttempt < 2; sessionAttempt += 1) {
      let upload = resumableImportUploads.get(file);
      if (!upload) {
        upload = {
          session: await api.post<ImportUploadSession>(
            endpoints.system.dataTransfer.importSession,
            { size: file.size },
          ),
          completedChunks: 0,
        };
        resumableImportUploads.set(file, upload);
      }
      const { session } = upload;
      try {
        if (upload.completedChunks > 0) {
          onProgress?.(upload.completedChunks, session.totalChunks);
        }
        for (let index = upload.completedChunks; index < session.totalChunks; index += 1) {
          const start = index * session.chunkSize;
          await uploadWithRetry(
            session.uploadId,
            index,
            file.slice(start, Math.min(file.size, start + session.chunkSize)),
          );
          upload.completedChunks = index + 1;
          onProgress?.(index + 1, session.totalChunks);
        }
        const result = await postTransferStream<ImportResult>(
          endpoints.system.dataTransfer.importFinalizeStream(session.uploadId),
          { passphrase, mode },
        );
        resumableImportUploads.delete(file);
        return result;
      } catch (error) {
        lastError = error;
        // A gone/expired session cannot be resumed. Transparently open one new
        // session once; other failures retain the verified chunks so correcting
        // a passphrase or merge choice is cheap.
        if (!(error instanceof ApiError) || error.status !== 410) throw error;
        resumableImportUploads.delete(file);
        if (sessionAttempt > 0) throw error;
      }
    }
    throw lastError;
  },
};
