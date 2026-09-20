/**
 * In-memory registry of folder-upload sessions.
 *
 * Deliberately dependency-free (only node:crypto + a Map): it holds the session
 * RECORD, not the machinery. `folder.service` owns the heavy, mode-specific
 * bits (Oblien provisioning, node:fs staging, tar extraction) and writes here;
 * the deploy pipeline (`build.service`) only READS a record, so it can import
 * this store statically without dragging cloud/self-hosted code into its graph.
 * Mirrors the isolation pattern used for local-source (node:fs stays out of the
 * cloud module graph).
 *
 * RAM-only on purpose — the workspace / staging dir a session points at is
 * itself short-lived, so surviving a restart is meaningless.
 */

import { randomBytes } from "node:crypto";
// Type-only — keeps this module runtime-dependency-free (see the note above).
import type { DeployableService } from "../../../lib/deployable-service";
import type { OpenshipEnv } from "@repo/core";

export type FolderUploadMode = "oblien-direct" | "api-relay";

export interface FolderSession {
  id: string;
  orgId: string;
  userId: string;
  /** Optional resource binding for a project-scoped credential. */
  projectId?: string;
  mode: FolderUploadMode;
  createdAt: number;
  expiresAt: number;
  /** Cloud (oblien-direct): the provisioned workspace the browser uploads into. */
  workspaceId?: string;
  /** Self-hosted (api-relay): staging dir on this host + single-use upload ticket. */
  stagingDir?: string;
  uploadTicket?: string;
  /** True once bytes have landed (api-relay: after upload; oblien-direct: assumed). */
  uploaded: boolean;
  uploading?: boolean;
  /** Detected/typed name hint for the project. */
  name?: string;
  /**
   * Compose services from the client-visible scan of the uploaded source. This
   * remains the immutable edit baseline for the session: deploy-time refreshes
   * use the final project env but do not replace it, so retries cannot mistake a
   * stale wizard payload for an intentional image override.
   */
  services?: DeployableService[];
  /** Trusted, pre-mask source env retained for the eventual build request. */
  rootEnv?: Record<string, string>;
  /** The subset explicitly declared by openship.json (automatic defaults). */
  openshipEnv?: OpenshipEnv;
}

const sessions = new Map<string, FolderSession>();

export function newFolderSessionId(): string {
  return randomBytes(18).toString("base64url");
}

export function putFolderSession(session: FolderSession): void {
  sessions.set(session.id, session);
}

export function getFolderSession(sessionId: string): FolderSession | undefined {
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  if (s.expiresAt <= Date.now()) {
    // Keep the record for the owner's sweep/close so its staging is reclaimed.
    return undefined;
  }
  return s;
}

export function deleteFolderSession(id: string): FolderSession | undefined {
  const session = sessions.get(id);
  sessions.delete(id);
  return session;
}

/**
 * Drop expired sessions and RETURN the evicted records so the caller can clean
 * up any on-disk staging they own — this module stays free of node:fs so it's
 * safe to import from cloud code paths.
 */
export function sweepExpiredFolderSessions(now: number): FolderSession[] {
  const evicted: FolderSession[] = [];
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now) {
      sessions.delete(id);
      evicted.push(s);
    }
  }
  return evicted;
}

/** Resource owner shutdown: expire all owned sources after execution has drained. */
export function takeAllFolderSessions(): FolderSession[] {
  const result = [...sessions.values()];
  sessions.clear();
  return result;
}
