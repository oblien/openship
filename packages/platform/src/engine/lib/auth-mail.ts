import { reportCaughtError } from "@repo/core/diagnostics";
import { APIError } from "better-auth/api";
import { isSaasDeployment } from "../config/saas-deployment";
import { CLOUD_MAIL_UNAVAILABLE, sendMail, type SendMailOptions } from "./mail";

/** Translate Cloud submission failures into a service error for the auth caller. */
export async function sendAuthMail(
  mail: SendMailOptions,
  localFailureMessage: string,
): Promise<void> {
  try {
    if (await sendMail(mail)) return;
  } catch (error) {
    if (!isSaasDeployment) throw error;
    reportCaughtError(error, "platform/engine/lib/auth-mail");
  }
  throw new APIError("SERVICE_UNAVAILABLE", {
    message: isSaasDeployment ? CLOUD_MAIL_UNAVAILABLE : localFailureMessage,
  });
}
