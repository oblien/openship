import { NextRequest, NextResponse } from "next/server";
import {
  AppError,
  BRAND_LINKS,
  CLOUD_API_URL,
  SUPPORT_EMAIL,
} from "@repo/core";
import {
  diagnosticId,
  reportError,
  reportCaughtError,
} from "@repo/core/diagnostics";
import { withErrorContext } from "@repo/core/diagnostics/node";
import {
  CloudSupportInputSchema,
  CloudSupportReceiptSchema,
  parseInput,
} from "@repo/contracts";

export const runtime = "nodejs";

/** Public website adapter. Persistence and mail delivery belong to the Cloud API. */
export async function POST(req: NextRequest) {
  const requestId = diagnosticId();
  return withErrorContext(
    {
      source: "web",
      kind: "http",
      component: "web/contact",
      requestId,
      traceId: requestId,
      method: "POST",
      route: "/api/contact",
    },
    async () => {
      const response = await submitSupportRequest(req, requestId);
      response.headers.set("X-Request-ID", requestId);
      return response;
    },
    true,
  );
}

async function submitSupportRequest(req: NextRequest, requestId: string) {
  const origin = req.headers.get("origin");
  if (
    origin &&
    origin !== BRAND_LINKS.site &&
    (process.env.NODE_ENV === "production" ||
      origin !== new URL(req.url).origin)
  ) {
    reportError("Origin not allowed", { statusCode: 403, handled: true });
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }
  try {
    // Bound streaming bodies too; Content-Length is optional and untrusted.
    const reader = req.body?.getReader();
    if (!reader) throw new AppError("Enter a support request.", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536)
          throw new AppError(
            "The message is too large. Please shorten it and try again.",
            413,
          );
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {
        // diagnostics-ignore: cancellation is cleanup after the bounded body read.
      });
      reader.releaseLock();
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      reportCaughtError(error, "web/contact.decode");
      throw new AppError("Enter a valid support request.", 400);
    }
    const input = parseInput(CloudSupportInputSchema, decoded);
    const response = await fetch(
      `${CLOUD_API_URL.replace(/\/$/, "")}/api/cloud/support`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
        cache: "no-store",
      },
    );
    if (!response.ok) {
      if ([400, 409, 413, 429].includes(response.status)) {
        const data = await response.json().catch(() => {
          // diagnostics-ignore: the failed upstream status is recorded below, even without a JSON message.
          return null;
        });
        const error =
          typeof data?.error === "string"
            ? data.error
            : "Couldn't save your request. Please check the form and try again.";
        const retryAfter = response.headers.get("retry-after");
        reportError(error, {
          statusCode: response.status,
          handled: true,
          providerRequestId: response.headers.get("X-Request-ID") ?? undefined,
        });
        return NextResponse.json(
          { error },
          {
            status: response.status,
            headers: retryAfter ? { "Retry-After": retryAfter } : {},
          },
        );
      }
      throw new Error("Cloud support is unavailable");
    }
    let receipt;
    try {
      receipt = parseInput(CloudSupportReceiptSchema, await response.json());
    } catch (error) {
      throw new Error("Cloud support returned no valid receipt", {
        cause: error,
      });
    }
    return NextResponse.json(receipt, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    reportError(error, {
      statusCode: error instanceof AppError ? error.statusCode : 503,
      handled: true,
    });
    if (
      error instanceof AppError &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    return NextResponse.json(
      {
        error: `Couldn't confirm your request was saved. Your message is still here—retry safely, or email ${SUPPORT_EMAIL}.`,
      },
      { status: 503 },
    );
  }
}
