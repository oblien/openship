import type { ChatAppProvider, ChatAppPurpose, ChatAppTransport } from "./chat-apps";

/** The same setup field definitions serve the form and the agent's setup guidance. */
export const CHAT_APP_PROVIDER_NAMES = {
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  teams: "Microsoft Teams",
};
export type ChatAppConnectionField = {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  hint: string;
  half?: boolean;
  maxLength?: number;
};
const fields: Record<ChatAppProvider, ChatAppConnectionField[]> = {
  slack: [
    {
      key: "workspaceId",
      label: "Slack workspace ID",
      placeholder: "T0123456789",
      hint: "The T… ID in your Slack workspace’s browser URL.",
    },
    {
      key: "botToken",
      label: "Bot token",
      placeholder: "xoxb-…",
      hint: "From OAuth & Permissions → Bot User OAuth Token.",
      maxLength: 2048,
    },
    {
      key: "signingSecret",
      label: "Signing secret",
      secret: true,
      placeholder: "Paste the signing secret",
      hint: "From Basic Information → App Credentials.",
    },
  ],
  discord: [
    {
      key: "workspaceId",
      label: "Discord server ID",
      placeholder: "123456789012345678",
      hint: "Enable Developer Mode, then copy your server’s ID.",
      half: true,
    },
    {
      key: "applicationId",
      label: "Application ID",
      placeholder: "123456789012345678",
      hint: "From your app’s General Information page.",
      half: true,
    },
    {
      key: "botToken",
      label: "Bot token",
      placeholder: "Paste your bot token",
      hint: "From the Bot page in the Discord Developer Portal.",
      maxLength: 2048,
    },
    {
      key: "publicKey",
      label: "Application public key",
      placeholder: "Paste the public key",
      hint: "From General Information → Public Key.",
    },
  ],
  telegram: [
    {
      key: "botToken",
      label: "Bot token from BotFather",
      placeholder: "123456789:AA…",
      hint: "Create a bot with /newbot in BotFather, then paste its token here.",
      maxLength: 2048,
    },
    {
      key: "webhookSecret",
      label: "Webhook secret",
      secret: true,
      placeholder: "At least 16 letters, numbers, _ or -",
      hint: "Use this same secret when you register the webhook with Telegram.",
    },
  ],
  teams: [
    {
      key: "workspaceId",
      label: "Microsoft Entra tenant ID",
      placeholder: "Directory (tenant) ID",
      hint: "From the app registration’s Overview page.",
      half: true,
    },
    {
      key: "applicationId",
      label: "Bot application ID",
      placeholder: "Application (client) ID",
      hint: "Use the ID registered with your Azure Bot.",
      half: true,
    },
    {
      key: "clientSecret",
      label: "Client secret",
      secret: true,
      placeholder: "Paste the secret value",
      hint: "From Certificates & secrets. Use the value, not the secret ID.",
      maxLength: 2048,
    },
    {
      key: "serviceUrl",
      label: "Teams connector service URL",
      placeholder: "https://smba.trafficmanager.net/…",
      hint: "The serviceUrl for the Teams conversation you want to connect.",
      maxLength: 512,
    },
  ],
};
export function chatAppConnectionFields(
  provider: ChatAppProvider,
  transport: ChatAppTransport,
): ChatAppConnectionField[] {
  return fields[provider].flatMap((field) => {
    if (transport === "webhook") return [field];
    if (field.key === "signingSecret")
      return [
        {
          key: "appToken",
          label: "Socket Mode app token",
          placeholder: "xapp-…",
          hint: "From Basic Information → App-Level Tokens, with connections:write.",
          maxLength: 2048,
        },
      ];
    if (field.key === "webhookSecret" || field.key === "publicKey") return [];
    return [field];
  });
}

export function chatAppGuide(provider?: ChatAppProvider) {
  return `https://openship.io/docs/dashboard/chat-apps${provider ? `/${provider}` : ""}`;
}

export interface ChatAppSetup {
  kind: "chat-app-setup";
  organizationId: string;
  provider: ChatAppProvider;
  purpose: ChatAppPurpose;
  transport: ChatAppTransport;
  setupPath: string;
  guideUrl: string;
  fields: Pick<ChatAppConnectionField, "key" | "label" | "hint">[];
  steps: string[];
  created: false;
}

export function chatAppSetup(
  provider: ChatAppProvider,
  purpose: ChatAppPurpose = "commands",
  transport: ChatAppTransport = provider === "teams" ? "webhook" : "outbound",
): Omit<ChatAppSetup, "organizationId"> {
  return {
    kind: "chat-app-setup",
    provider,
    purpose,
    transport,
    created: false,
    setupPath: `/settings?tab=chat-apps&connect=${provider}&purpose=${purpose}&transport=${transport}`,
    guideUrl: chatAppGuide(provider),
    fields: chatAppConnectionFields(provider, transport).map(({ key, label, hint }) => ({
      key,
      label,
      hint,
    })),
    steps: [
      "Open the connection form and enter bot credentials there, never in this conversation.",
      "Choose the allowed channels or chats, then save. New connections start paused.",
      "Enable the saved connector when ready. Each sender runs /openship link and completes the normal OpenShip permission review and verification.",
      purpose === "commands"
        ? "Use /openship help for deployment commands. The control plane does not need AI, Mindwire, or an assistant connection."
        : "Each sender connects their own assistant separately. Assistant access and chat-command permissions remain separate.",
      transport === "outbound"
        ? "This uses a direct outbound connection. No public OpenShip URL is needed; keep OpenShip online."
        : "This transport requires a reachable public HTTPS webhook endpoint.",
    ],
  };
}
