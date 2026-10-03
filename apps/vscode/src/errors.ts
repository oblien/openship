import { stripVTControlCharacters } from "node:util";
import { ApiError } from "@repo/sdk/client";

export class UserCancelled extends Error {}

export function cleanText(text: string): string {
  return stripVTControlCharacters(text).replace(/opsh_pat_[^\s"'<>]+/g, "[redacted token]");
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401)
      return "Your access token expired or was revoked. Run Openship: Update Access Token.";
    // The API also uses 403 for deployment preflight failures. Keep its
    // actionable reason; permission guidance is only a fallback for bare errors.
    if (
      error.status === 403 &&
      ["", "forbidden", "api error: 403"].includes(error.message.trim().toLowerCase())
    )
      return "This token cannot perform that operation. Check its permissions and the selected organization.";
  }
  return cleanText(error instanceof Error ? error.message : "The Openship request failed.");
}
