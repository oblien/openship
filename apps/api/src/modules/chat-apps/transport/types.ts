import type { ChatAppCreate, ChatAppView } from "@repo/contracts";
import type { ChatAppConnection } from "@repo/db";
import type { ChatReply } from "../chat-reply";
import type { ChatSender } from "../chat-apps-common";

export interface HostEvent extends ChatSender {
  id: string;
  integrationId: string;
  text: string;
  lease: string;
  revision: number;
  command: boolean;
  callback?: string;
}
export type ChatSettings = Pick<
  ChatAppCreate,
  "channelIds" | "workspaceId" | "applicationId" | "serviceUrl" | "credentials"
>;
export type PublicChatSettings = Omit<ChatSettings, "credentials">;
export interface BotConfiguration extends ChatSettings {
  botId: string;
  username?: string;
}
export interface IncomingMessage extends ChatSender {
  id: string;
  text: string;
  command: boolean;
  callback?: string;
  /** Provider reply capability; encrypted in the inbox, never sent to the dispatcher/model. */
  reply?: { token?: string; ephemeral?: boolean; activityId?: string; callbackId?: string };
}
export type WebhookResponse = { status: number; body: string; contentType: string };
export type ReceiverStatus = NonNullable<ChatAppView["receiver"]>;
export interface ChatTransport {
  configure(c: ChatAppConnection, settings: ChatSettings): Promise<void>;
  configuration(c: ChatAppConnection): Promise<PublicChatSettings>;
  activate(c: ChatAppConnection): Promise<void>;
  stop(c: ChatAppConnection): Promise<void>;
  poll(c: ChatAppConnection): Promise<ReceiverStatus>;
  claim(c: ChatAppConnection): Promise<HostEvent | null>;
  complete(c: ChatAppConnection, event: HostEvent, reply: ChatReply): Promise<void>;
  forward(
    c: ChatAppConnection,
    body: string,
    headers: Record<string, string>,
  ): Promise<WebhookResponse>;
  remove(c: ChatAppConnection): Promise<void>;
  sweep(active: ChatAppConnection[]): Promise<void>;
  close(): Promise<void>;
}
export type ProviderFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type Receive = (event: IncomingMessage) => Promise<void>;
export type ReceiverFactory = (
  c: ChatAppConnection,
  config: BotConfiguration,
  hooks: {
    receive: Receive;
    acknowledged(eventId: string): Promise<void>;
    cursor: string | null;
    saveCursor(cursor: string): Promise<void>;
    status(value: ReceiverStatus): void;
    signal: AbortSignal;
  },
) => Promise<void>;
