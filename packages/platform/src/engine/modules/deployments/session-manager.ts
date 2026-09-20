/** API process composition; native instances own a separate manager. */
import { createSessionManager } from "@repo/platform";
import { PROMPT_TIMEOUT_MS } from "../../lib/prompt-gateway";
export type { ServiceStatusPayload, BuildSessionState, SseWriter, PromptPayload } from "@repo/platform";
const manager = createSessionManager({ promptTimeoutMs: PROMPT_TIMEOUT_MS });
export const { createSession, getSession, clearDecisionPending, appendLog, broadcastServiceStatus, broadcastInstallPhase, updateStatus, subscribe, removeSession, promptUser, respondToPrompt, cancelPendingPrompt, close: closeSessionManager } = manager;
