import { createHmac } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { AppError } from "@repo/core";

const identity = z.object({
  organizationId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  jobId: z.string().min(1).max(128),
  purpose: z.enum(["runtime", "upload", "download", "user-download"]),
  objectId: z.number().int().positive().optional(),
  viewer: z
    .object({
      version: z.literal(1),
      userId: z.string(),
      organizationId: z.string(),
      token: z
        .object({ id: z.string(), kind: z.enum(["pat", "oauth"]), scoped: z.boolean() })
        .nullable(),
      restrictions: z
        .object({
          organizationId: z.string().nullable(),
          readOnly: z.boolean(),
          expiresAt: z.number().nullable(),
        })
        .nullable(),
    })
    .optional(),
  exp: z.number().int(),
});
export type ActionRuntimeIdentity = z.infer<typeof identity>;

/** Purpose-bound, expiring capabilities. These never authorize a user session,
 * a server command, a different job, or a backup destination's other objects. */
export class ActionRuntimeTokens {
  private readonly key: Uint8Array;
  constructor(secret: string) {
    this.key = createHmac("sha256", secret).update("openship/actions/runtime/v1").digest();
  }
  async issue(input: Omit<ActionRuntimeIdentity, "exp">, seconds: number): Promise<string> {
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 6 * 3600 + 600)
      throw new Error("Invalid Actions token lifetime");
    return new SignJWT({ ...input, scp: `Actions.Results:${input.runId}:${input.jobId}` })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("openship-actions")
      .setAudience("openship-actions-runtime")
      .setSubject(input.jobId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
      .sign(this.key);
  }
  async verify(
    token: string | undefined,
    purpose: ActionRuntimeIdentity["purpose"] | ActionRuntimeIdentity["purpose"][],
  ): Promise<ActionRuntimeIdentity> {
    if (!token || token.length > 4096)
      throw new AppError(
        "Actions runtime credential required",
        401,
        "ACTIONS_RUNTIME_UNAUTHORIZED",
      );
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: "openship-actions",
        audience: "openship-actions-runtime",
        requiredClaims: ["exp", "iat", "sub"],
      });
      const result = identity.parse(payload);
      if (
        !(Array.isArray(purpose) ? purpose : [purpose]).includes(result.purpose) ||
        payload.sub !== result.jobId ||
        (result.purpose !== "runtime" && !result.objectId) ||
        (result.purpose === "user-download" &&
          (!result.viewer || result.viewer.organizationId !== result.organizationId)) ||
        (result.purpose !== "user-download" && result.viewer)
      )
        throw new Error("Invalid capability");
      return result;
    } catch (cause) {
      const error = new AppError(
        "Actions runtime credential is invalid or expired",
        401,
        "ACTIONS_RUNTIME_UNAUTHORIZED",
      );
      error.cause = cause;
      throw error;
    }
  }
}
