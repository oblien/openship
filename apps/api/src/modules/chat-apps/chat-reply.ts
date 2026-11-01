/** Provider-neutral output. URLs remain separate messages; buttons never carry raw credentials. */
export interface ChatMessage {
  text: string;
  buttons?: { label: string; token: string }[];
}
export interface ChatReply {
  messages: ChatMessage[];
}
export const chatReply = (...messages: (string | ChatMessage)[]): ChatReply => ({
  messages: messages.map((message) => (typeof message === "string" ? { text: message } : message)),
});
