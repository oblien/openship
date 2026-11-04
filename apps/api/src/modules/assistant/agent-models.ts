import {
  assistantDefaultModel,
  assistantModelReady,
  OperationError,
  type AssistantAgentModelProvider,
  type AssistantProviderInfo,
} from "@repo/contracts";

/** Explicit projection: never expose auth methods, settings, endpoints or credentials to tools. */
export function agentModelProvider(info: AssistantProviderInfo): AssistantAgentModelProvider {
  const preferred = assistantDefaultModel(info);
  const ready = assistantModelReady(info, preferred);
  return {
    id: info.id,
    name: info.name,
    available: info.available,
    ready,
    defaultModel: ready ? preferred : null,
    models: info.models
      .filter((model) => assistantModelReady(info, model.id))
      .map((model) => ({
        id: model.id,
        label: model.label,
        default: preferred ? model.id === preferred : model.default === true,
      })),
    ...(!info.available
      ? { issue: info.issue || `${info.name} is not installed on the selected assistant host.` }
      : !ready
        ? { issue: `Connect ${info.name} in Agents settings before using it.` }
        : {}),
  };
}

export function assertAgentModel(info: AssistantProviderInfo, model: string): void {
  const connection = agentModelProvider(info);
  const details = { connection, modelsPath: "/api/assistant/agents/models" };
  if (!info.available)
    throw new OperationError(connection.issue!, 409, "ASSISTANT_PROVIDER_UNAVAILABLE", details);
  if (!model.startsWith("openship-") && !info.authStatus.configured)
    throw new OperationError(
      `Sign in to ${info.name} in Agents settings, or choose a ready connection from the agent model catalog.`,
      409,
      "ASSISTANT_SIGN_IN",
      details,
    );
  if (model && !info.models.some((item) => item.id === model))
    throw new OperationError(
      'This model is not available on the selected connection. Read the agent model catalog and use an exact ID, or model="" for the connected native default.',
      400,
      "ASSISTANT_MODEL_UNAVAILABLE",
      details,
    );
  if (!assistantModelReady(info, model))
    throw new OperationError(
      "Connect this model in Agents settings before using it.",
      409,
      "ASSISTANT_SIGN_IN",
      details,
    );
}
