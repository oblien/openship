import { abortable } from "./cancellation";
import { TextDecoder } from "node:util";
import { AppError, isRecord, type Deployment, type DeploymentBuildStatus, type DeploymentEvent, type DeploymentOperations, type PromptPayload } from "@repo/contracts";

export interface DeploymentOutcome {
  deploymentId: string;
  status: string;
  success: boolean;
  decisionPending: boolean;
  cancellationPending: boolean;
  prompt?: PromptPayload;
  message?: string;
  warning?: string;
}
export interface WaitForDeploymentOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Absent: return an action_required outcome so the caller can choose how to respond. */
  onPrompt?: (prompt: PromptPayload) => string | Promise<string>;
}
export interface DecodedDeploymentEvent extends DeploymentEvent {
  payload: Record<string, unknown>;
  log?: string;
}
export interface DeploymentStreamResult {
  status?: string;
  success?: boolean;
  message?: string;
  warning?: string;
  failedServices?: Array<{ id: string; name: string }>;
  serviceCount: number;
  completed: boolean;
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal); }
  finally { if (timer) clearTimeout(timer); }
}

const terminal = new Set(["ready", "failed", "cancelled", "partial_failure", "action_required", "rejected", "no_changes"]);

/** Waits on persisted status; ending a log stream alone is never proof of success. */
export async function waitForDeployment(operations: DeploymentOperations, id: string, options: WaitForDeploymentOptions = {}): Promise<DeploymentOutcome> {
  const { timeoutMs, pollIntervalMs = 1000, onPrompt } = options;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 10) throw new TypeError("pollIntervalMs must be at least 10");
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError("timeoutMs must be positive");
  const deadline = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const signals = [options.signal, deadline].filter((s): s is AbortSignal => !!s);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const answered = new Set<string>();
  for (;;) {
    signal?.throwIfAborted();
    const status = await abortable(operations.buildStatus(id), signal);
    const state = status.deploymentStatus;
    const outcome: DeploymentOutcome = {
      deploymentId: id, status: state, success: state === "ready" || state === "no_changes",
      decisionPending: status.decisionPending, cancellationPending: status.cancellationPending,
      ...(status.errorMessage && { message: status.errorMessage }),
      ...(status.warningMessage && { warning: status.warningMessage }),
    };
    if (status.pendingPrompt) {
      const prompt = status.pendingPrompt;
      if (!onPrompt) return { ...outcome, status: "action_required", success: false, prompt };
      const key = prompt.promptId + ":" + (prompt.expiresAt ?? "");
      if (!answered.has(key)) {
        const action = await abortable(Promise.resolve().then(() => onPrompt(structuredClone(prompt))), signal);
        if (!prompt.actions.some((choice) => choice.id === action))
          throw new AppError("Prompt response is not one of its offered actions", 400, "INVALID_PROMPT_ACTION");
        signal?.throwIfAborted();
        const response = await operations.respond(id, { action });
        if (!response.success) throw new AppError("Deployment prompt expired or was already answered", 409, "PROMPT_UNAVAILABLE");
        answered.add(key);
      }
    } else if (terminal.has(state) && !status.cancellationPending) return outcome;
    await pause(pollIntervalMs, signal);
  }
}

/** Decode logs and collect streaming hints, independently of terminal rendering. */
export async function consumeDeploymentEvents(
  events: AsyncIterable<DeploymentEvent>,
  onEvent?: (event: DecodedDeploymentEvent) => void | Promise<void>,
): Promise<DeploymentStreamResult> {
  const result: DeploymentStreamResult = { serviceCount: 0, completed: false };
  const services = new Map<string, { name: string; status: string }>();
  const decoders = new Map<string, TextDecoder>();
  for await (const event of events) {
    let payload: Record<string, unknown> = {};
    try { const parsed: unknown = JSON.parse(event.data); if (isRecord(parsed)) payload = parsed; }
    catch { if (event.event === "log") payload = { message: event.data }; }
    let log: string | undefined;
    if (event.event === "log") {
      if (typeof payload.message === "string") log = payload.message;
      else if (typeof payload.data === "string") {
        const key = typeof payload.serviceId === "string" ? payload.serviceId : "";
        let decoder = decoders.get(key);
        if (!decoder) decoders.set(key, decoder = new TextDecoder());
        log = decoder.decode(Buffer.from(payload.data, "base64"), { stream: true });
      }
    }
    if (event.event === "service-status" && typeof payload.serviceId === "string") {
      services.set(payload.serviceId, { name: typeof payload.serviceName === "string" ? payload.serviceName : payload.serviceId, status: String(payload.status ?? "") });
    } else if (event.event === "complete") {
      result.success = payload.success === true;
      result.message = typeof payload.message === "string" ? payload.message : undefined;
      result.warning = typeof payload.warningMessage === "string" ? payload.warningMessage : undefined;
    } else if (event.event === "cancelled") {
      result.status = "cancelled"; result.success = false;
      result.message = typeof payload.message === "string" ? payload.message : "Deployment cancelled";
    } else if (event.event === "end") {
      result.status = typeof payload.status === "string" ? payload.status : result.status;
      result.completed = typeof payload.status === "string" && terminal.has(payload.status);
    } else if (event.event === "error") {
      result.message = typeof payload.error === "string" ? payload.error : "Event stream error";
    }
    await onEvent?.({ ...event, payload, ...(log !== undefined && { log }) });
    if (event.event === "end" || event.event === "error") break;
  }
  result.serviceCount = services.size;
  const failed = [...services].filter(([, service]) => service.status === "failed").map(([id, service]) => ({ id, name: service.name }));
  if (failed.length) { result.failedServices = failed; result.success = false; }
  return result;
}

export interface DeploymentHandle {
  readonly id: string;
  get(): Promise<Deployment>;
  status(): Promise<DeploymentBuildStatus>;
  wait(options?: WaitForDeploymentOptions): Promise<DeploymentOutcome>;
  events(options?: Parameters<DeploymentOperations["events"]>[1]): ReturnType<DeploymentOperations["events"]>;
  cancel(): ReturnType<DeploymentOperations["cancel"]>;
  respond(action: string): ReturnType<DeploymentOperations["respond"]>;
  rollback(): ReturnType<DeploymentOperations["rollback"]>;
}
export function createDeploymentHandle(operations: DeploymentOperations, id: string): DeploymentHandle {
  if (typeof id !== "string" || !id) throw new TypeError("Deployment ID is required");
  return Object.freeze({
    id, get: () => operations.get(id), status: () => operations.buildStatus(id),
    wait: (options?: WaitForDeploymentOptions) => waitForDeployment(operations, id, options),
    events: (options?: Parameters<DeploymentOperations["events"]>[1]) => operations.events(id, options),
    cancel: () => operations.cancel(id), respond: (action: string) => operations.respond(id, { action }),
    rollback: () => operations.rollback(id),
  });
}
