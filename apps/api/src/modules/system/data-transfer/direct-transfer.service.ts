/**
 * One-time, instance-to-instance transfer.
 *
 * The destination creates an ephemeral X25519 keypair and an unguessable
 * capability. The source encrypts the scrubbed dump + plaintext credential
 * bundle directly to that public key. Only the destination can open it, and it
 * immediately re-encrypts every credential under its own instance key.
 */

import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

import { decryptWithKey, encryptWithKey } from "../../../lib/encryption";
import { prepareInstanceExport } from "./export.service";
import { importPreparedInstance } from "./import.service";
import type {
  DirectTransferConnection,
  DirectTransferEnvelope,
  DirectTransferPayload,
  DirectTransferResult,
  ExportSelection,
  ImportMode,
  ImportResult,
} from "./types";

const SESSION_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_SESSIONS = 20;
const DIRECT_RECEIVE_PATH = "system/data-transfer/direct/receive";
const KEY_CONTEXT = Buffer.from("openship-direct-transfer-v1", "utf8");
const DIRECT_RUNTIME_ID = randomUUID();

interface ReceiveSession {
  id: string;
  tokenHash: Buffer;
  privateKey: KeyObject;
  mode: ImportMode;
  expiresAtMs: number;
  consuming: boolean;
}

const receiveSessions = new Map<string, ReceiveSession>();

export class InvalidDirectTransferCodeError extends Error {
  readonly code = "INVALID_DIRECT_TRANSFER_CODE" as const;
  constructor(message = "The receive code is invalid or malformed.") {
    super(message);
    this.name = "InvalidDirectTransferCodeError";
  }
}

export class DirectTransferSessionError extends Error {
  readonly code = "DIRECT_TRANSFER_SESSION_UNAVAILABLE" as const;
  constructor(message = "The receive code expired, was already used, or is not available on this instance.") {
    super(message);
    this.name = "DirectTransferSessionError";
  }
}

export class DirectTransferDestinationError extends Error {
  readonly code = "DIRECT_TRANSFER_DESTINATION_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "DirectTransferDestinationError";
  }
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function cleanupSessions(now = Date.now()): void {
  for (const [id, session] of receiveSessions) {
    if (session.expiresAtMs <= now) receiveSessions.delete(id);
  }
}

function normalizeApiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidDirectTransferCodeError("The destination API URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidDirectTransferCodeError("The destination must use an HTTP or HTTPS URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new InvalidDirectTransferCodeError("The destination URL cannot contain credentials, query parameters, or a fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString();
}

function assertConnection(value: unknown): DirectTransferConnection {
  if (!value || typeof value !== "object") throw new InvalidDirectTransferCodeError();
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    typeof item.apiBase !== "string" ||
    typeof item.recipientRuntimeId !== "string" ||
    typeof item.sessionId !== "string" ||
    typeof item.token !== "string" ||
    typeof item.recipientPublicKey !== "string" ||
    (item.mode !== "wipe" && item.mode !== "merge") ||
    typeof item.expiresAt !== "string"
  ) {
    throw new InvalidDirectTransferCodeError();
  }
  if (
    item.recipientRuntimeId.length < 20 ||
    item.recipientRuntimeId.length > 100 ||
    item.sessionId.length > 100 ||
    item.token.length < 32 ||
    item.token.length > 200
  ) {
    throw new InvalidDirectTransferCodeError();
  }
  const expiresAtMs = Date.parse(item.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new DirectTransferSessionError("The receive code has expired. Generate a new one on the destination.");
  }
  return {
    version: 1,
    apiBase: normalizeApiBase(item.apiBase),
    recipientRuntimeId: item.recipientRuntimeId,
    sessionId: item.sessionId,
    token: item.token,
    recipientPublicKey: item.recipientPublicKey,
    mode: item.mode,
    expiresAt: item.expiresAt,
  };
}

export function encodeDirectTransferCode(connection: DirectTransferConnection): string {
  return Buffer.from(JSON.stringify(connection), "utf8").toString("base64url");
}

export function decodeDirectTransferCode(code: string): DirectTransferConnection {
  if (typeof code !== "string" || code.length < 40 || code.length > 8_192) {
    throw new InvalidDirectTransferCodeError();
  }
  try {
    return assertConnection(JSON.parse(Buffer.from(code.trim(), "base64url").toString("utf8")));
  } catch (error) {
    if (error instanceof InvalidDirectTransferCodeError || error instanceof DirectTransferSessionError) {
      throw error;
    }
    throw new InvalidDirectTransferCodeError();
  }
}

function deriveTransferKey(privateKey: KeyObject, publicKey: KeyObject, sessionId: string): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(sessionId, "utf8"), KEY_CONTEXT, 32));
}

export function sealDirectTransferPayload(
  connection: DirectTransferConnection,
  payload: DirectTransferPayload,
): DirectTransferEnvelope {
  let recipientPublicKey: KeyObject;
  try {
    recipientPublicKey = createPublicKey({
      key: Buffer.from(connection.recipientPublicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (recipientPublicKey.asymmetricKeyType !== "x25519") throw new Error("wrong key type");
  } catch {
    throw new InvalidDirectTransferCodeError("The receive code contains an invalid destination key.");
  }

  const { publicKey: senderPublicKey, privateKey: senderPrivateKey } = generateKeyPairSync("x25519");
  const key = deriveTransferKey(senderPrivateKey, recipientPublicKey, connection.sessionId);
  return {
    version: 1,
    sessionId: connection.sessionId,
    senderPublicKey: senderPublicKey.export({ format: "der", type: "spki" }).toString("base64"),
    blob: encryptWithKey(key, JSON.stringify(payload)),
  };
}

export function createDirectReceiveSession(opts: {
  apiBase: string;
  mode: ImportMode;
}): { code: string; expiresAt: string; mode: ImportMode } {
  cleanupSessions();
  if (receiveSessions.size >= MAX_ACTIVE_SESSIONS) {
    throw new DirectTransferSessionError("Too many active receive codes. Wait for an existing code to expire.");
  }

  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  receiveSessions.set(id, {
    id,
    tokenHash: tokenDigest(token),
    privateKey,
    mode: opts.mode,
    expiresAtMs,
    consuming: false,
  });

  const expiresAt = new Date(expiresAtMs).toISOString();
  const connection: DirectTransferConnection = {
    version: 1,
    apiBase: normalizeApiBase(opts.apiBase),
    recipientRuntimeId: DIRECT_RUNTIME_ID,
    sessionId: id,
    token,
    recipientPublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    mode: opts.mode,
    expiresAt,
  };
  return { code: encodeDirectTransferCode(connection), expiresAt, mode: opts.mode };
}

export async function sendDirectTransfer(opts: {
  code: string;
  selection?: ExportSelection;
  fetchImpl?: typeof fetch;
}): Promise<DirectTransferResult> {
  const connection = decodeDirectTransferCode(opts.code);
  if (connection.recipientRuntimeId === DIRECT_RUNTIME_ID) {
    throw new InvalidDirectTransferCodeError("The receive code belongs to this same instance. Generate it on the destination instance.");
  }
  const prepared = await prepareInstanceExport(opts.selection);
  const payload: DirectTransferPayload = {
    version: 1,
    authorizationToken: connection.token,
    file: prepared.file,
    secrets: prepared.secrets,
  };
  const envelope = sealDirectTransferPayload(connection, payload);

  const receiveUrl = new URL(DIRECT_RECEIVE_PATH, connection.apiBase);
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(receiveUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      redirect: "error",
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch (error) {
    throw new DirectTransferDestinationError(
      error instanceof Error ? `Could not reach the destination: ${error.message}` : "Could not reach the destination.",
    );
  }

  const body = await response.json().catch(() => null) as (ImportResult & { error?: string }) | null;
  if (!response.ok || !body) {
    throw new DirectTransferDestinationError(body?.error || `Destination returned HTTP ${response.status}.`);
  }
  return { ...body, destination: receiveUrl.origin };
}

export async function receiveDirectTransfer(envelope: DirectTransferEnvelope): Promise<ImportResult> {
  cleanupSessions();
  if (
    !envelope ||
    envelope.version !== 1 ||
    typeof envelope.sessionId !== "string" ||
    typeof envelope.senderPublicKey !== "string" ||
    typeof envelope.blob !== "string"
  ) {
    throw new InvalidDirectTransferCodeError("The encrypted transfer envelope is invalid.");
  }

  const session = receiveSessions.get(envelope.sessionId);
  if (!session || session.consuming || session.expiresAtMs <= Date.now()) {
    throw new DirectTransferSessionError();
  }

  let payload: DirectTransferPayload;
  try {
    const senderPublicKey = createPublicKey({
      key: Buffer.from(envelope.senderPublicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (senderPublicKey.asymmetricKeyType !== "x25519") throw new Error("wrong key type");
    const key = deriveTransferKey(session.privateKey, senderPublicKey, session.id);
    payload = JSON.parse(decryptWithKey(key, envelope.blob)) as DirectTransferPayload;
  } catch {
    throw new InvalidDirectTransferCodeError("The transfer could not be authenticated or decrypted.");
  }

  if (
    payload?.version !== 1 ||
    typeof payload.authorizationToken !== "string" ||
    !payload.file
  ) {
    throw new InvalidDirectTransferCodeError("The decrypted transfer payload is invalid.");
  }
  const suppliedHash = tokenDigest(payload.authorizationToken);
  if (!timingSafeEqual(session.tokenHash, suppliedHash)) {
    throw new DirectTransferSessionError();
  }

  // Consume atomically before the first database await. A receive code can
  // authorize exactly one import attempt, including when that import fails.
  session.consuming = true;
  try {
    return await importPreparedInstance({
      file: payload.file,
      secrets: payload.secrets ?? null,
      mode: session.mode,
    });
  } finally {
    receiveSessions.delete(session.id);
  }
}

/** Test-only visibility without exposing private session material. */
export function clearDirectReceiveSessionsForTest(): void {
  if (process.env.NODE_ENV === "test") receiveSessions.clear();
}
