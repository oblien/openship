/** Process-owned prompt defaults. The registry implementation is shared with native instances. */
import { PromptRegistry as SharedPromptRegistry } from "@repo/platform";
import { env } from "../config/env";
export type { PromptPayload } from "@repo/core";
export const PROMPT_TIMEOUT_MS = (() => {
  const raw = Number(env.OPENSHIP_PROMPT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();
export class PromptRegistry extends SharedPromptRegistry {
  constructor(timeoutMs = PROMPT_TIMEOUT_MS) { super(timeoutMs); }
}
