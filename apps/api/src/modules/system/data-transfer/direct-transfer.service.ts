/**
 * One-time, instance-to-instance transfer.
 *
 * A receive capability is persisted in the destination database and the source
 * uploads independently authenticated 8 MB ciphertext chunks. This keeps every
 * request below the edge proxy limit, bounds request memory, survives API worker
 * changes/restarts, and extends the lease while a large export is being prepared.
 * The legacy one-envelope receiver remains for transfers from older sources.
 */

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { readSseTerminalEvent } from "@repo/core";

import {
  decrypt,
  decryptBytesWithKey,
  decryptWithKey,
  encrypt,
  encryptBytesWithKey,
  encryptWithKey,
} from "../../../lib/encryption";
import {
  assertCompleteChunkSet,
  beginDirectSession,
  claimSession,
  clearTransferSessionsForTest,
  completeSessionInTransaction,
  createDirectSession,
  failSession,
  getSession,
  listChunkMetadata,
  MAX_TRANSFER_BYTES,
  sha256Hex,
  stageChunk,
  touchSession,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_CONTROL_BODY_BYTES,
  TransferStoreError,
  withSessionClaimLease,
  type TransferSessionRow,
} from "./chunk-store";
import { prepareInstanceExport } from "./export.service";
import { importPreparedInstance } from "./import.service";
import { jsonByteChunks } from "./json-chunks";
import { readStagedJson } from "./staged-payload";
import type {
  DirectTransferConnection,
  DirectTransferEnvelope,
  DirectTransferPayload,
  DirectTransferResult,
  ExportSelection,
  ImportMode,
  ImportResult,
} from "./types";

const DIRECT_RECEIVE_PATH = "system/data-transfer/direct/receive";
const DIRECT_CHUNK_INIT_PATH = "system/data-transfer/direct/chunk/init";
const DIRECT_CHUNK_FINALIZE_STREAM_SUFFIX = "finalize/stream";
const KEY_CONTEXT = Buffer.from("openship-direct-transfer-v1", "utf8");
const DIRECT_RUNTIME_ID = randomUUID();
const HEARTBEAT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 2 * 60_000;
const FINALIZE_TIMEOUT_MS = 6 * 60 * 60_000;

interface DirectChunkInit {
  version: 1;
  sessionId: string;
  mode: ImportMode;
  senderPublicKey: string;
  proof: string;
}

interface DirectChunkManifest {
  totalChunks: number;
  totalBytes: number;
  sha256: string;
  signature: string;
}

interface SenderContext {
  key: Buffer;
  senderPublicKey: string;
}

export class InvalidDirectTransferCodeError extends Error {
  readonly code = "INVALID_DIRECT_TRANSFER_CODE" as const;
  constructor(message = "The receive code is invalid or malformed.") {
    super(message);
    this.name = "InvalidDirectTransferCodeError";
  }
}

export class DirectTransferSessionError extends Error {
  readonly code = "DIRECT_TRANSFER_SESSION_UNAVAILABLE" as const;
  constructor(
    message = "The receive code expired, was already used, or is not available on this instance.",
  ) {
    super(message);
    this.name = "DirectTransferSessionError";
  }
}

export class DirectTransferDestinationError extends Error {
  readonly code = "DIRECT_TRANSFER_DESTINATION_FAILED" as const;
  constructor(
    message: string,
    readonly status?: number,
    readonly destinationCode?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DirectTransferDestinationError";
  }
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
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
    throw new InvalidDirectTransferCodeError(
      "The destination URL cannot contain credentials, query parameters, or a fragment.",
    );
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
  // This timestamp is display metadata for the initial idle lease. An active
  // transfer renews its authoritative database lease, but the already-copied
  // code cannot be rewritten with each heartbeat. Reject malformed timestamps
  // here and let the destination return 410 for an actually expired session;
  // otherwise a source retry after ten minutes would reject a still-live lease.
  if (!Number.isFinite(Date.parse(item.expiresAt))) {
    throw new InvalidDirectTransferCodeError("The receive code expiry is invalid.");
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
    if (
      error instanceof InvalidDirectTransferCodeError ||
      error instanceof DirectTransferSessionError
    ) {
      throw error;
    }
    throw new InvalidDirectTransferCodeError();
  }
}

function deriveTransferKey(privateKey: KeyObject, publicKey: KeyObject, sessionId: string): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(sessionId, "utf8"), KEY_CONTEXT, 32));
}

function parsePublicKey(encoded: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "x25519") throw new Error("wrong key type");
  return key;
}

function senderContext(connection: DirectTransferConnection): SenderContext {
  let recipientPublicKey: KeyObject;
  try {
    recipientPublicKey = parsePublicKey(connection.recipientPublicKey);
  } catch {
    throw new InvalidDirectTransferCodeError(
      "The receive code contains an invalid destination key.",
    );
  }
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    key: deriveTransferKey(privateKey, recipientPublicKey, connection.sessionId),
    senderPublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function sessionPrivateKey(session: TransferSessionRow): KeyObject {
  if (!session.privateKey) throw new DirectTransferSessionError();
  try {
    const key = createPrivateKey({
      key: Buffer.from(decrypt(session.privateKey), "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (key.asymmetricKeyType !== "x25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new DirectTransferSessionError(
      "The receive session key is unavailable on this instance.",
    );
  }
}

function sessionKey(session: TransferSessionRow, senderPublicKey?: string): Buffer {
  try {
    return deriveTransferKey(
      sessionPrivateKey(session),
      parsePublicKey(senderPublicKey ?? session.senderPublicKey ?? ""),
      session.id,
    );
  } catch (error) {
    if (error instanceof DirectTransferSessionError) throw error;
    throw new InvalidDirectTransferCodeError("The sender transfer key is invalid.");
  }
}

function sign(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

function signatureMatches(key: Buffer, message: string, supplied: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = Buffer.from(sign(key, message), "hex");
  const actual = Buffer.from(supplied, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function tokenMatches(session: TransferSessionRow, token: string): boolean {
  if (!session.tokenHash || !/^[a-f0-9]{64}$/.test(session.tokenHash)) return false;
  const expected = Buffer.from(session.tokenHash, "hex");
  const actual = tokenDigest(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function directSession(id: string): Promise<TransferSessionRow> {
  const session = await getSession(id);
  if (!session || session.kind !== "direct") throw new DirectTransferSessionError();
  return session;
}

export function sealDirectTransferPayload(
  connection: DirectTransferConnection,
  payload: DirectTransferPayload,
): DirectTransferEnvelope {
  const sender = senderContext(connection);
  return {
    version: 1,
    sessionId: connection.sessionId,
    senderPublicKey: sender.senderPublicKey,
    blob: encryptWithKey(sender.key, JSON.stringify(payload)),
  };
}

export async function createDirectReceiveSession(opts: {
  apiBase: string;
  mode: ImportMode;
}): Promise<{ code: string; expiresAt: string; mode: ImportMode }> {
  const token = randomBytes(32).toString("base64url");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const stored = await createDirectSession({
    mode: opts.mode,
    tokenHash: tokenDigest(token).toString("hex"),
    privateKey: encrypt(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")),
  });
  const expiresAt = stored.expiresAt.toISOString();
  const connection: DirectTransferConnection = {
    version: 1,
    apiBase: normalizeApiBase(opts.apiBase),
    recipientRuntimeId: DIRECT_RUNTIME_ID,
    sessionId: stored.id,
    token,
    recipientPublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    mode: opts.mode,
    expiresAt,
  };
  return { code: encodeDirectTransferCode(connection), expiresAt, mode: opts.mode };
}

async function responseBody(response: Response): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > TRANSFER_CONTROL_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new DirectTransferDestinationError("Destination returned an oversized response.");
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TRANSFER_CONTROL_BODY_BYTES) {
        throw new DirectTransferDestinationError("Destination returned an oversized response.");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function requireDestinationResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await responseBody(response);
  if (!response.ok || !body) {
    throw new DirectTransferDestinationError(
      typeof body?.error === "string"
        ? body.error
        : `Destination returned HTTP ${response.status}.`,
      response.status,
      typeof body?.code === "string" ? body.code : undefined,
    );
  }
  return body;
}

async function fetchDestination(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new DirectTransferDestinationError(
      error instanceof Error
        ? `Could not reach the destination: ${error.message}`
        : "Could not reach the destination.",
      undefined,
      undefined,
      true,
    );
  }
}

async function initializeDestination(
  connection: DirectTransferConnection,
  sender: SenderContext,
  fetchImpl: typeof fetch,
): Promise<{ result?: ImportResult } | null> {
  const proof = encryptWithKey(
    sender.key,
    JSON.stringify({
      version: 1,
      sessionId: connection.sessionId,
      mode: connection.mode,
      authorizationToken: connection.token,
    }),
  );
  const response = await fetchDestination(
    fetchImpl,
    new URL(DIRECT_CHUNK_INIT_PATH, connection.apiBase),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        sessionId: connection.sessionId,
        mode: connection.mode,
        senderPublicKey: sender.senderPublicKey,
        proof,
      } satisfies DirectChunkInit),
    },
  );
  // A pre-chunking destination still accepts the legacy encrypted envelope.
  if (response.status === 404 || response.status === 405) return null;
  const body = await requireDestinationResponse(response);
  return {
    result:
      body.result && typeof body.result === "object"
        ? (body.result as unknown as ImportResult)
        : undefined,
  };
}

async function heartbeatDestination(
  connection: DirectTransferConnection,
  sender: SenderContext,
  fetchImpl: typeof fetch,
): Promise<void> {
  const message = `heartbeat:${connection.sessionId}`;
  const response = await fetchDestination(
    fetchImpl,
    new URL(
      `system/data-transfer/direct/chunk/${encodeURIComponent(connection.sessionId)}/heartbeat`,
      connection.apiBase,
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature: sign(sender.key, message) }),
    },
  );
  await requireDestinationResponse(response);
}

async function uploadDestinationChunk(input: {
  connection: DirectTransferConnection;
  sender: SenderContext;
  fetchImpl: typeof fetch;
  index: number;
  ciphertext: Buffer;
}): Promise<void> {
  const digest = sha256Hex(input.ciphertext);
  const message = `chunk:${input.connection.sessionId}:${input.index}:${digest}`;
  const url = new URL(
    `system/data-transfer/direct/chunk/${encodeURIComponent(input.connection.sessionId)}/${input.index}`,
    input.connection.apiBase,
  );

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchDestination(input.fetchImpl, url, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-openship-chunk-sha256": digest,
          "x-openship-transfer-signature": sign(input.sender.key, message),
        },
        body: input.ciphertext,
      });
      await requireDestinationResponse(response);
      return;
    } catch (error) {
      lastError = error;
      if (
        error instanceof DirectTransferDestinationError &&
        error.status &&
        error.status < 500 &&
        error.status !== 429
      ) {
        throw error;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function finalizeDestinationOnce(
  connection: DirectTransferConnection,
  sender: SenderContext,
  manifest: Omit<DirectChunkManifest, "signature">,
  fetchImpl: typeof fetch,
): Promise<ImportResult> {
  const message = `finalize:${connection.sessionId}:${manifest.totalChunks}:${manifest.totalBytes}:${manifest.sha256}`;
  const response = await fetchDestination(
    fetchImpl,
    new URL(
      `system/data-transfer/direct/chunk/${encodeURIComponent(connection.sessionId)}/${DIRECT_CHUNK_FINALIZE_STREAM_SUFFIX}`,
      connection.apiBase,
    ),
    {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...manifest,
        signature: sign(sender.key, message),
      } satisfies DirectChunkManifest),
    },
    FINALIZE_TIMEOUT_MS,
  );
  if (!response.ok) await requireDestinationResponse(response);
  if (
    !(response.headers.get("content-type") ?? "").includes("text/event-stream") ||
    !response.body
  ) {
    throw new DirectTransferDestinationError("Destination returned an invalid transfer stream.");
  }
  try {
    const terminal = await readSseTerminalEvent(response.body);
    if (terminal.event === "complete") return JSON.parse(terminal.data) as ImportResult;
    const failure = JSON.parse(terminal.data) as {
      status?: number;
      error?: string;
      code?: string;
    };
    throw new DirectTransferDestinationError(
      typeof failure.error === "string" ? failure.error : "Destination import failed.",
      typeof failure.status === "number" ? failure.status : undefined,
      typeof failure.code === "string" ? failure.code : undefined,
    );
  } catch (error) {
    if (error instanceof DirectTransferDestinationError) throw error;
    const retryable =
      !(error instanceof SyntaxError) &&
      !(error instanceof Error && error.message.includes("oversized frame"));
    throw new DirectTransferDestinationError(
      error instanceof Error
        ? `Destination transfer stream failed: ${error.message}`
        : "Destination transfer stream failed.",
      undefined,
      undefined,
      retryable,
    );
  }
}

function retryableFinalizeFailure(error: unknown): boolean {
  if (!(error instanceof DirectTransferDestinationError)) return false;
  if (error.destinationCode === "SESSION_BUSY") return true;
  if (error.destinationCode === "BUSY") return false;
  return (
    error.retryable ||
    error.status === 429 ||
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504
  );
}

/**
 * Retrying finalization is safe because the manifest and sender key are stable,
 * and the destination keeps the completed result briefly. This closes the
 * ambiguous-outcome gap where the restore commits but its terminal SSE frame is
 * lost during a proxy or worker restart.
 */
async function finalizeDestination(
  connection: DirectTransferConnection,
  sender: SenderContext,
  manifest: Omit<DirectChunkManifest, "signature">,
  fetchImpl: typeof fetch,
): Promise<ImportResult> {
  const deadline = Date.now() + FINALIZE_TIMEOUT_MS;
  let attempt = 0;
  for (;;) {
    try {
      return await finalizeDestinationOnce(connection, sender, manifest, fetchImpl);
    } catch (error) {
      if (!retryableFinalizeFailure(error) || Date.now() >= deadline) throw error;
      const busy =
        error instanceof DirectTransferDestinationError && error.destinationCode === "SESSION_BUSY";
      if (!busy && attempt >= 2) throw error;
      const delay = Math.min(1_000 * 2 ** Math.min(attempt, 3), 10_000);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function sendLegacyTransfer(
  connection: DirectTransferConnection,
  payload: DirectTransferPayload,
  fetchImpl: typeof fetch,
): Promise<ImportResult> {
  const envelope = sealDirectTransferPayload(connection, payload);
  const response = await fetchDestination(
    fetchImpl,
    new URL(DIRECT_RECEIVE_PATH, connection.apiBase),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    },
    FINALIZE_TIMEOUT_MS,
  );
  return (await requireDestinationResponse(response)) as unknown as ImportResult;
}

export async function sendDirectTransfer(opts: {
  code: string;
  selection?: ExportSelection;
  fetchImpl?: typeof fetch;
}): Promise<DirectTransferResult> {
  const connection = decodeDirectTransferCode(opts.code);
  // The process id is a fast legacy check, but is not stable across restarts or
  // multiple API workers. The durable capability record is authoritative: if
  // this database owns the session+token, sending would target ourselves.
  const localSession = await getSession(connection.sessionId);
  if (
    connection.recipientRuntimeId === DIRECT_RUNTIME_ID ||
    (localSession?.kind === "direct" && tokenMatches(localSession, connection.token))
  ) {
    throw new InvalidDirectTransferCodeError(
      "The receive code belongs to this same instance. Generate it on the destination instance.",
    );
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const sender = senderContext(connection);
  const initialized = await initializeDestination(connection, sender, fetchImpl);
  const chunked = initialized !== null;
  if (initialized?.result) {
    return {
      ...initialized.result,
      destination: new URL(connection.apiBase).origin,
    };
  }

  let heartbeatBusy = false;
  const heartbeat = chunked
    ? setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void heartbeatDestination(connection, sender, fetchImpl)
          .catch(() => undefined)
          .finally(() => {
            heartbeatBusy = false;
          });
      }, HEARTBEAT_INTERVAL_MS)
    : null;
  heartbeat?.unref?.();

  try {
    const prepared = await prepareInstanceExport(opts.selection);
    const payload: DirectTransferPayload = {
      version: 1,
      authorizationToken: connection.token,
      file: prepared.file,
      secrets: prepared.secrets,
    };

    if (!chunked) {
      const result = await sendLegacyTransfer(connection, payload, fetchImpl);
      return { ...result, destination: new URL(connection.apiBase).origin };
    }

    const hash = createHash("sha256");
    let totalBytes = 0;
    let totalChunks = 0;
    for (const plaintext of jsonByteChunks(payload, TRANSFER_CHUNK_BYTES)) {
      totalBytes += plaintext.byteLength;
      totalChunks += 1;
      if (totalBytes > MAX_TRANSFER_BYTES) {
        throw new DirectTransferDestinationError(
          `Transfer exceeds the ${Math.floor(MAX_TRANSFER_BYTES / 1_000_000)}MB limit. Exclude optional history and retry.`,
          413,
        );
      }
      hash.update(plaintext);
      await uploadDestinationChunk({
        connection,
        sender,
        fetchImpl,
        index: totalChunks - 1,
        ciphertext: encryptBytesWithKey(sender.key, plaintext),
      });
    }
    const result = await finalizeDestination(
      connection,
      sender,
      { totalChunks, totalBytes, sha256: hash.digest("hex") },
      fetchImpl,
    );
    return { ...result, destination: new URL(connection.apiBase).origin };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

export async function initializeDirectChunkUpload(input: DirectChunkInit) {
  if (
    input?.version !== 1 ||
    typeof input.sessionId !== "string" ||
    (input.mode !== "wipe" && input.mode !== "merge") ||
    typeof input.senderPublicKey !== "string" ||
    typeof input.proof !== "string"
  ) {
    throw new InvalidDirectTransferCodeError("The chunked transfer handshake is invalid.");
  }
  const current = await directSession(input.sessionId);
  if (input.mode !== current.mode) throw new DirectTransferSessionError();
  if (
    current.status !== "ready" &&
    current.status !== "uploading" &&
    current.status !== "complete"
  ) {
    throw new DirectTransferSessionError();
  }
  const key = sessionKey(current, input.senderPublicKey);
  let proof: Record<string, unknown>;
  try {
    proof = JSON.parse(decryptWithKey(key, input.proof)) as Record<string, unknown>;
  } catch {
    throw new InvalidDirectTransferCodeError("The transfer handshake could not be authenticated.");
  }
  if (
    proof.version !== 1 ||
    proof.sessionId !== current.id ||
    proof.mode !== current.mode ||
    typeof proof.authorizationToken !== "string" ||
    !tokenMatches(current, proof.authorizationToken)
  ) {
    throw new DirectTransferSessionError();
  }
  if (current.status === "complete" && current.result) {
    return {
      chunkSize: TRANSFER_CHUNK_BYTES,
      expiresAt: current.expiresAt.toISOString(),
      result: current.result as unknown as ImportResult,
    };
  }
  const session = await beginDirectSession(current.id, input.senderPublicKey);
  if (!session) throw new DirectTransferSessionError();
  return { chunkSize: TRANSFER_CHUNK_BYTES, expiresAt: session.expiresAt.toISOString() };
}

function requireDirectSignature(
  session: TransferSessionRow,
  supplied: string,
  message: string,
): Buffer {
  const key = sessionKey(session);
  if (!signatureMatches(key, message, supplied)) {
    throw new InvalidDirectTransferCodeError("The transfer request signature is invalid.");
  }
  return key;
}

export async function heartbeatDirectChunkUpload(sessionId: string, signature: string) {
  const session = await directSession(sessionId);
  if (session.status !== "uploading") throw new DirectTransferSessionError();
  requireDirectSignature(session, signature, `heartbeat:${session.id}`);
  const touched = await touchSession(session.id, session.senderPublicKey!);
  if (!touched) throw new DirectTransferSessionError();
  return { expiresAt: touched.expiresAt.toISOString() };
}

export async function receiveDirectChunk(input: {
  sessionId: string;
  index: number;
  sha256: string;
  signature: string;
  readBytes: () => Promise<Uint8Array>;
}): Promise<void> {
  if (
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  ) {
    throw new TransferStoreError("The transfer chunk metadata is invalid.", "INVALID_CHUNK");
  }
  const session = await directSession(input.sessionId);
  if (session.status !== "uploading") throw new DirectTransferSessionError();
  requireDirectSignature(
    session,
    input.signature,
    `chunk:${session.id}:${input.index}:${input.sha256}`,
  );
  // Resolve and authenticate the small capability metadata before materializing
  // an untrusted multi-megabyte request body.
  const bytes = await input.readBytes();
  await stageChunk({
    session,
    index: input.index,
    bytes,
    sha256: input.sha256,
  });
}

function assertDirectManifest(value: DirectChunkManifest): void {
  if (
    !value ||
    !Number.isSafeInteger(value.totalChunks) ||
    value.totalChunks <= 0 ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes <= 0 ||
    value.totalBytes > MAX_TRANSFER_BYTES ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.signature !== "string"
  ) {
    throw new InvalidDirectTransferCodeError("The transfer manifest is invalid.");
  }
}

export async function finalizeDirectChunkUpload(
  sessionId: string,
  manifest: DirectChunkManifest,
): Promise<ImportResult> {
  assertDirectManifest(manifest);
  const current = await directSession(sessionId);
  const key = requireDirectSignature(
    current,
    manifest.signature,
    `finalize:${current.id}:${manifest.totalChunks}:${manifest.totalBytes}:${manifest.sha256}`,
  );
  if (current.status === "complete" && current.result) {
    return current.result as unknown as ImportResult;
  }
  if (current.status === "consuming") {
    throw new TransferStoreError(
      "The destination is still finalizing this transfer.",
      "SESSION_BUSY",
    );
  }
  if (current.status !== "uploading") throw new DirectTransferSessionError();

  const metadata = await listChunkMetadata(current.id);
  assertCompleteChunkSet(metadata, manifest.totalChunks);
  const session = await claimSession(current);
  try {
    return await withSessionClaimLease(session, async () => {
      const payload = (await readStagedJson(session, manifest, (bytes) =>
        decryptBytesWithKey(key, bytes),
      )) as DirectTransferPayload;
      if (
        payload?.version !== 1 ||
        typeof payload.authorizationToken !== "string" ||
        !tokenMatches(session, payload.authorizationToken) ||
        !payload.file
      ) {
        throw new InvalidDirectTransferCodeError("The decrypted transfer payload is invalid.");
      }
      return importPreparedInstance({
        file: payload.file,
        secrets: payload.secrets ?? null,
        mode: session.mode === "merge" ? "merge" : "wipe",
        onBeforeCommit: (tx, imported) => completeSessionInTransaction(tx, session, imported),
      });
    });
  } catch (error) {
    await failSession(session).catch(() => undefined);
    throw error;
  }
}

/** Legacy single-envelope receiver for a source that has not learned chunking. */
export async function receiveDirectTransfer(
  envelope: DirectTransferEnvelope,
): Promise<ImportResult> {
  if (
    !envelope ||
    envelope.version !== 1 ||
    typeof envelope.sessionId !== "string" ||
    typeof envelope.senderPublicKey !== "string" ||
    typeof envelope.blob !== "string"
  ) {
    throw new InvalidDirectTransferCodeError("The encrypted transfer envelope is invalid.");
  }

  const current = await directSession(envelope.sessionId);
  const key = sessionKey(current, envelope.senderPublicKey);
  let payload: DirectTransferPayload;
  try {
    payload = JSON.parse(decryptWithKey(key, envelope.blob)) as DirectTransferPayload;
  } catch {
    throw new InvalidDirectTransferCodeError(
      "The transfer could not be authenticated or decrypted.",
    );
  }
  if (payload?.version !== 1 || typeof payload.authorizationToken !== "string" || !payload.file) {
    throw new InvalidDirectTransferCodeError("The decrypted transfer payload is invalid.");
  }
  if (!tokenMatches(current, payload.authorizationToken)) {
    throw new DirectTransferSessionError();
  }
  if (current.status === "complete" && current.result) {
    return current.result as unknown as ImportResult;
  }
  const begun = await beginDirectSession(current.id, envelope.senderPublicKey);
  if (!begun) throw new DirectTransferSessionError();
  const session = await claimSession(begun);
  try {
    return await withSessionClaimLease(session, () =>
      importPreparedInstance({
        file: payload.file,
        secrets: payload.secrets ?? null,
        mode: session.mode === "merge" ? "merge" : "wipe",
        onBeforeCommit: (tx, imported) => completeSessionInTransaction(tx, session, imported),
      }),
    );
  } catch (error) {
    await failSession(session).catch(() => undefined);
    throw error;
  }
}

/** Test-only cleanup without exposing key material. */
export async function clearDirectReceiveSessionsForTest(): Promise<void> {
  await clearTransferSessionsForTest();
}
