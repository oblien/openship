import { PROJECT_COMMANDS, validCommandId } from "./project";
type ChatAppPurpose = "assistant" | "commands" | "both";
/** Shared chat aliases, help and native menus. Execution remains in each authenticated client. */
interface ChatCommandDefinition {
  verb: string;
  argument: "project-id" | "conversation-id" | "code" | "message" | null;
  group: "projects" | "deployments" | "account" | "assistant";
  description: string;
}

export const CHAT_COMMANDS = [
  {
    verb: "ask",
    argument: "message",
    group: "assistant",
    description: "Talk to your connected assistant. Requires your opt-in.",
  },
  {
    verb: "new",
    argument: null,
    group: "assistant",
    description: "Start a fresh assistant conversation here.",
  },
  {
    verb: "stop",
    argument: null,
    group: "assistant",
    description: "Stop your assistant's current turn here.",
  },
  {
    verb: "chats",
    argument: null,
    group: "assistant",
    description: "List your recent assistant conversations from this chat.",
  },
  {
    verb: "resume",
    argument: "conversation-id",
    group: "assistant",
    description: "Continue one of your conversations from this chat, with its existing history.",
  },
  {
    verb: "chat",
    argument: null,
    group: "assistant",
    description: "Open the current conversation in OpenShip. Continue from either place.",
  },
  {
    verb: PROJECT_COMMANDS.list.chat,
    argument: PROJECT_COMMANDS.list.argument,
    group: "projects",
    description: "List up to 20 projects you can access, with their IDs.",
  },
  {
    verb: PROJECT_COMMANDS.get.chat,
    argument: PROJECT_COMMANDS.get.argument,
    group: "projects",
    description: "Check the latest deployment. For live app health, open the project.",
  },
  {
    verb: PROJECT_COMMANDS.logs.chat,
    argument: PROJECT_COMMANDS.logs.argument,
    group: "projects",
    description: "Open private logs in OpenShip. Log contents stay out of chat.",
  },
  {
    verb: PROJECT_COMMANDS.redeploy.chat,
    argument: PROJECT_COMMANDS.redeploy.argument,
    group: "deployments",
    description: "Request a deployment of the latest source through the normal pipeline.",
  },
  {
    verb: PROJECT_COMMANDS.restart.chat,
    argument: PROJECT_COMMANDS.restart.argument,
    group: "deployments",
    description: "Request a restart of the active deployment.",
  },
  {
    verb: "confirm",
    argument: "code",
    group: "deployments",
    description: "Confirm the requested action within five minutes, in the same conversation.",
  },
  {
    verb: "link",
    argument: null,
    group: "account",
    description: "Connect your own OpenShip account and choose its permissions.",
  },
  {
    verb: "verify",
    argument: "code",
    group: "account",
    description: "Finish linking with the code from OpenShip, in the original conversation.",
  },
  {
    verb: "unlink",
    argument: null,
    group: "account",
    description: "Disconnect your chat account and revoke its OpenShip access.",
  },
  {
    verb: "start",
    argument: null,
    group: "account",
    description: "Open the welcome menu and quick actions.",
  },
  { verb: "help", argument: null, group: "account", description: "Show every available command." },
] as const satisfies readonly ChatCommandDefinition[];

export type ChatCommand = (typeof CHAT_COMMANDS)[number];

export function chatCommandAvailable(command: ChatCommand, purpose: ChatAppPurpose): boolean {
  return (
    command.group === "account" ||
    purpose === "both" ||
    (command.group === "assistant" ? purpose === "assistant" : purpose === "commands")
  );
}

export function chatCommandUsage(command: ChatCommand): string {
  return `/openship ${command.verb}${command.argument ? ` <${command.argument}>` : ""}`;
}

/** Provider menus are generated from the same catalog as parsing and help. */
export function chatNativeCommands(purpose: ChatAppPurpose) {
  return CHAT_COMMANDS.filter((command) => chatCommandAvailable(command, purpose)).map(
    (command) => ({
      name: command.verb,
      description: command.description,
      ...(command.argument ? { argument: command.argument.replaceAll("-", "_") } : {}),
    }),
  );
}

/** Merge these entries into features.slash_commands; never replace a user's whole manifest. */
export function chatSlackCommands(purpose: ChatAppPurpose, webhookUrl?: string) {
  const destination = webhookUrl ? { url: webhookUrl } : {};
  return [
    {
      command: "/openship",
      description: "OpenShip commands and help",
      usage_hint: "help",
      should_escape: false,
      ...destination,
    },
    ...chatNativeCommands(purpose).map((command) => ({
      command: `/openship-${command.name}`,
      description: command.description,
      usage_hint: command.argument ? `<${command.argument}>` : "",
      should_escape: false,
      ...destination,
    })),
  ];
}

/** Accept canonical CLI project syntax and the shorter native-chat aliases. No shell grammar. */
export function parseChatCommand(text: string): { verb: ChatCommand["verb"]; arg?: string } {
  const body = text
    .trim()
    .replace(/^\/openship(?:@[\w]+)?(?:\s+|$)/i, "")
    .trim();
  const parts = body.split(/\s+/);
  let verb = (parts.shift() || "help").toLowerCase();
  if (verb === "project" || (verb === "projects" && parts.length > 0)) {
    const subcommand = parts.shift();
    const definition = Object.values(PROJECT_COMMANDS).find((c) => c.name === subcommand);
    if (!definition) return { verb: "help" };
    verb = definition.chat;
  }
  const definition = CHAT_COMMANDS.find((c) => c.verb === verb);
  if (!definition) return { verb: "help" };
  if (definition.argument === "message") {
    const start = body.search(/\s/);
    const arg = start < 0 ? "" : body.slice(start).trim();
    return arg && arg.length <= 16000 ? { verb: definition.verb, arg } : { verb: "help" };
  }
  if (!parts.length && definition.argument === "project-id") return { verb: definition.verb };
  if (
    parts.length > 1 ||
    (definition.argument ? !parts[0] || !validCommandId(parts[0]) : parts.length > 0)
  )
    return { verb: "help" };
  return { verb: definition.verb, arg: parts[0] };
}
