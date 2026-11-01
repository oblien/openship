import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { AppError } from "@repo/core";
import {
  CLOUD_SUPPORT_ACCOUNT_HEADER,
  CloudSupportSessionSchema,
  parseInput,
} from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import {
  cloudFetch,
  cloudSessionCacheKey,
  readCloudJson,
  readCloudSession,
} from "../../lib/cloud/transport";
import type { StoredCloudSession } from "../../lib/cloud/types";

export interface LinkedSupportResult {
  status: number;
  payload: unknown;
  retryAfter?: string;
}

function requireLocalCustomer(ctx: ExecutionContext) {
  // Zero-auth is a local identity established by the API's loopback/instance
  // auth policy. Team grants and API tokens cannot borrow a private Cloud link.
  if (
    !["cookie", "zero-auth"].includes(ctx.sessionKind) ||
    ctx.principalKind ||
    ctx.tokenScope ||
    ctx.credential ||
    !ctx.userId ||
    ctx.user?.id !== ctx.userId
  )
    throw new AppError("Sign in to manage your support tickets.", 403, "SUPPORT_SESSION_REQUIRED");
}

function accountChanged(): never {
  throw new AppError(
    "Your Cloud connection changed. Reload Support before continuing.",
    409,
    "SUPPORT_ACCOUNT_CHANGED",
  );
}

const unavailable = () =>
  new AppError(
    "We couldn’t reach Openship Support. Please try again.",
    502,
    "SUPPORT_CLOUD_UNAVAILABLE",
  );

/** Customer endpoints only. The caller constructs the path from validated input. */
async function forward(
  ctx: ExecutionContext,
  session: StoredCloudSession,
  path: string,
  responseSchema: TSchema,
  method = "GET",
  body?: unknown,
): Promise<LinkedSupportResult> {
  const key = cloudSessionCacheKey(ctx.userId, session);
  const response = await cloudFetch(
    ctx.userId,
    `/api/cloud/support${path}`,
    {
      method,
      // Cloud checks this against the real session before any write. Never forward
      // browser credentials, local organization headers, or an operator token.
      headers: { [CLOUD_SUPPORT_ACCOUNT_HEADER]: session.userId },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12_000),
    },
    session,
  );
  const payload = response ? await readCloudJson<unknown>(response) : null;
  const current = await readCloudSession(ctx.userId);
  if (!current || cloudSessionCacheKey(ctx.userId, current) !== key) accountChanged();
  if (!response) throw unavailable();

  if (response.ok) {
    if (
      response.status !== (method === "POST" ? 201 : 200) ||
      !Value.Check(responseSchema, payload)
    )
      throw unavailable();
    return { status: response.status, payload };
  }

  // Do not pass through Cloud internals, HTML error pages, or response cookies.
  // A support failure must not clear the shared deployment connection.
  const messages: Record<number, string> = {
    400: "Check your support request and try again.",
    401: "Sign in to Openship Cloud again to view your tickets.",
    403: "Sign in to Openship Cloud to manage your tickets.",
    404: "Support ticket not found.",
    409: "This request reference was already used for a different message.",
    413: "The message is too large. Please shorten it and try again.",
    429: "Too many support messages. Please try again later.",
  };
  const status = messages[response.status] ? response.status : 502;
  const retryAfter = response.headers.get("Retry-After");
  return {
    status,
    payload: {
      error: messages[status] ?? unavailable().message,
      code:
        status === 401 || status === 403
          ? "SUPPORT_CLOUD_SESSION_REQUIRED"
          : "SUPPORT_CLOUD_REQUEST_FAILED",
    },
    ...(status === 429 && retryAfter && /^\d{1,6}$/.test(retryAfter) ? { retryAfter } : {}),
  };
}

export async function getLinkedSupportSession(ctx: ExecutionContext): Promise<LinkedSupportResult> {
  requireLocalCustomer(ctx);
  // Intentionally per user. The org owner's link powers deployments, but it
  // does not authorize any teammate to read that owner's private conversations.
  const session = await readCloudSession(ctx.userId);
  if (!session) return { status: 200, payload: { account: null } };
  const result = await forward(ctx, session, "/session", CloudSupportSessionSchema);
  if (result.status !== 200) return result;
  const { account } = parseInput(CloudSupportSessionSchema, result.payload);
  if (!account || account.id !== session.userId) throw unavailable();
  return {
    status: 200,
    payload: { account: { ...account, key: cloudSessionCacheKey(ctx.userId, session) } },
  };
}

export async function requestLinkedSupport(
  ctx: ExecutionContext,
  expectedKey: string | undefined,
  path: string,
  responseSchema: TSchema,
  method = "GET",
  body?: unknown,
): Promise<LinkedSupportResult> {
  requireLocalCustomer(ctx);
  const session = await readCloudSession(ctx.userId);
  if (!session || expectedKey !== cloudSessionCacheKey(ctx.userId, session)) accountChanged();
  return forward(ctx, session, path, responseSchema, method, body);
}
