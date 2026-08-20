import { z } from "zod";

export const MINIMAX_MODELS = ["MiniMax-M3", "MiniMax-M2.7"] as const;
export const MINIMAX_BASE_URLS = [
  "https://api.minimax.io/v1",
  "https://api.minimaxi.com/v1",
] as const;

export type MiniMaxModel = (typeof MINIMAX_MODELS)[number];
export type MiniMaxBaseUrl = (typeof MINIMAX_BASE_URLS)[number];

export interface MiniMaxConfig {
  apiKey: string;
  model: MiniMaxModel;
  baseUrl: MiniMaxBaseUrl;
}

export interface MiniMaxMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
});

export async function createMiniMaxChatCompletion(
  config: MiniMaxConfig,
  messages: MiniMaxMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`MiniMax request failed with status ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("MiniMax returned an invalid JSON response.");
  }

  const parsed = completionSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("MiniMax returned an invalid chat completion response.");
  }

  const content = parsed.data.choices[0]!.message.content.trim();
  if (!content) {
    throw new Error("MiniMax returned an empty chat completion.");
  }

  return content;
}
