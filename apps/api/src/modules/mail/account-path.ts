import type { Context } from "hono";
import { AppError } from "@repo/core";
import { managedMailNamespacePattern } from "@repo/contracts/managed-mail";
import { readOptionalJsonBody } from "../../lib/request-body";

export async function readMailRequestBody(c: Context): Promise<Record<string, unknown>> {
  const body = await readOptionalJsonBody(c).catch(() => {
    throw new AppError("Invalid mail request body.", 400);
  });
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AppError("Invalid mail request body.", 400);
  return body as Record<string, unknown>;
}

export function workerTenant(c: Context) {
  const value = c.req.param("mailTenant");
  if (value !== undefined && !managedMailNamespacePattern.test(value))
    throw new AppError("Invalid mail tenant.", 400);
  return value;
}

/** Only paths declared by the mail routers reach this function.
 * Substitute each decoded segment independently. Never relay the request URL,
 * client credentials, cookies, or redirect responses to another service. */
export function mailRoutePath(pattern: string, params: Record<string, string>) {
  return pattern
    .split("/")
    .map((part) => {
      if (!part.startsWith(":")) return part;
      const value = params[part.slice(1)];
      if (!value || value === "." || value === ".." || /[%/\\\x00-\x1f]/.test(value))
        throw new AppError("Mail resource not found.", 404, "MAIL_NOT_FOUND");
      return encodeURIComponent(value);
    })
    .join("/");
}

export function mailAccountStatus(method: string, pattern: string) {
  return method === "POST" &&
    ["/domains", "/mailboxes", "/aliases"].some((suffix) => pattern.endsWith(suffix))
    ? 201
    : 200;
}

export function mailRequestDomains(c: Context, body?: Record<string, unknown>) {
  return [
    c.req.param("domain"),
    c.req.param("email")?.split("@").pop(),
    c.req.query("domain"),
    body?.domain,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
}
