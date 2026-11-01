import { parseAppearance } from "@repo/core";
import { ValidationError } from "@repo/contracts";
import { repos } from "@repo/db";
import type { AppearancePreferences } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { audit, operationAuditContext } from "../../lib/audit-emitter";

export async function getAppearance(ctx: ExecutionContext) {
  const appearance = await repos.settings.getAppearance(ctx.userId);
  // Do not turn a failed read into editable defaults; callers must offer retry.
  return { appearance: appearance == null ? null : parseAppearance(appearance) };
}
export async function setAppearance(
  ctx: ExecutionContext,
  input: { appearance: AppearancePreferences | null },
) {
  let appearance: AppearancePreferences | null;
  try {
    appearance = input.appearance === null ? null : parseAppearance(input.appearance);
  } catch {
    throw new ValidationError(
      "Invalid appearance JSON. Check theme tokens, font assets and the selected theme.",
    );
  }
  await repos.settings.setAppearance(ctx.userId, appearance);
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "settings.updated",
    resourceType: "settings",
    resourceId: ctx.userId,
    after: {
      action: "appearance.set",
      active: appearance?.active ?? null,
      themes: appearance?.themes.length ?? 0,
    },
  });
  return { appearance };
}
