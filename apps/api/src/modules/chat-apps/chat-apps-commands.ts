import { AppError, type AppLocale } from "@repo/core";
import {
  CHAT_COMMANDS,
  chatCommandUsage,
  chatCommandAvailable,
  type ChatAppPurpose,
} from "@repo/contracts";
import { repos, type ChatAppConnection, type ChatAppReceipt } from "@repo/db";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { resolveDashboardPublicUrl } from "@repo/platform/engine/lib/public-url";
import { getMcpTools } from "../mcp/mcp-tools";
import { dispatchTool, type DispatchResult } from "../mcp/mcp-dispatch";
import { pairingLink, verifyPairing, chatCredential, unlinkIdentity } from "./chat-apps-access";
import {
  challenge,
  readChallenge,
  enabled,
  fail,
  fingerprint,
  senderKey,
} from "./chat-apps-common";
import type { HostEvent } from "./transport/types";
import { parseChatCommand } from "@repo/commands";
export { parseChatCommand } from "@repo/commands";
import { chatReply, type ChatReply } from "./chat-reply";
import { chatActions, resolveChatAction } from "./chat-actions";
import { chatLocale } from "./chat-locale";
import { chatCopy, formatChat } from "./chat-copy";
export const commandHelp = (purpose: ChatAppPurpose, locale: AppLocale = "en") => {
  const copy = chatCopy(locale);
  return [
    copy.welcome,
    "",
    copy.help,
    ...CHAT_COMMANDS.filter((command) => chatCommandAvailable(command, purpose)).map(
      (command) => `${chatCommandUsage(command)} — ${copy.commands[command.verb]}`,
    ),
    "",
    copy.helpHint,
  ].join("\n");
};
export const COMMAND_HELP = commandHelp("both");
export const chatLabel = (v: unknown) =>
  typeof v === "string" ? v.replace(/[\r\n\x00-\x1f<>@`*_~]/g, " ").slice(0, 100) : "";
const label = chatLabel;
const identifier = (value: string) => (/^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : "");
const projectUrl = (id: string) =>
  `${resolveDashboardPublicUrl()}/projects/${encodeURIComponent(id)}`;
type Dispatch = typeof dispatchTool;
type ProjectSummary = { id: string; name: string; activeDeploymentId: string | null };
interface Confirmation {
  sender: string;
  identityId: string;
  clientId: string;
  revision: number;
  projectId: string;
  deploymentId: string;
  verb: "redeploy" | "restart";
}
/** The route registry and dispatcher are shared with MCP; no second deployment implementation. */
export interface ChatAssistantHandler {
  execute(c: ChatAppConnection, event: HostEvent, id: string): Promise<string | null>;
  result(c: ChatAppConnection, event: HostEvent, receipt: ChatAppReceipt): Promise<string | null>;
  validate(c: ChatAppConnection, event: HostEvent, receipt: ChatAppReceipt): Promise<void>;
}
export function chatInput(event: HostEvent) {
  return event.command || /^\/openship(?:@[\w]+)?(?:\s|$)/i.test(event.text.trim())
    ? parseChatCommand(event.text)
    : { verb: "ask" as const, arg: event.text.trim() };
}
export function createChatCommands(
  dispatch: Dispatch = dispatchTool,
  assistant?: ChatAssistantHandler,
) {
  async function execute(
    c: ChatAppConnection,
    event: HostEvent,
    locale: AppLocale,
  ): Promise<ChatReply> {
    const copy = chatCopy(locale);
    const reply = chatReply;
    const actions = (text: string, choices: { label: string; command: string }[]) =>
      chatActions(c, event, text, choices);
    const { verb, arg } = parseChatCommand(event.text);
    if (verb === "help" || verb === "start")
      return actions(verb === "start" ? copy.welcome : commandHelp(c.purpose, locale), [
        { label: copy.buttons.link, command: "link" },
        ...(verb === "start" ? [{ label: copy.buttons.help, command: "help" }] : []),
        ...(c.purpose !== "assistant"
          ? [{ label: copy.buttons.projects, command: "projects" }]
          : []),
        ...(c.purpose !== "commands"
          ? [
              { label: copy.buttons.chats, command: "chats" },
              { label: copy.buttons.new, command: "new" },
            ]
          : []),
      ]);
    if (verb === "link") return reply(copy.link, await pairingLink(c, event));
    if (verb === "verify") {
      await verifyPairing(c, event, arg!);
      const linkedCopy = chatCopy(await chatLocale(c, event));
      return actions(linkedCopy.linked, [
        { label: linkedCopy.buttons.help, command: "help" },
        ...(c.purpose !== "assistant"
          ? [{ label: linkedCopy.buttons.projects, command: "projects" }]
          : []),
      ]);
    }
    if (verb === "unlink") {
      const linked = await repos.chatApps.identity(c.id, event.workspaceId, event.userId);
      if (linked) await unlinkIdentity(linked.id, linked.userId);
      return reply(copy.unlinked);
    }
    if (!(await repos.chatApps.identity(c.id, event.workspaceId, event.userId)))
      return actions(copy.linkFirst, [{ label: copy.buttons.link, command: "link" }]);
    const { identity } = await chatCredential(c, event);
    async function call<T>(
      method: string,
      path: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      await enabled(c.id, c.revision);
      // Re-read the grant immediately before every operation, including confirmations.
      const credential = await chatCredential(c, event);
      if (
        credential.identity.id !== identity.id ||
        credential.identity.clientId !== identity.clientId
      )
        throw fail(copy.changed, 403);
      const tool = getMcpTools().find(
        (t) => t.method === method && t.path.replace(/\/$/, "") === path,
      );
      if (!tool) throw fail(copy.failed);
      const result: DispatchResult = await dispatch(
        tool,
        { ...args, organizationId: c.organizationId },
        credential.token,
        {
          principalId: `oauth:${identity.clientId}`,
          clientIp: null,
          userAgent: `OpenShip Chat/${c.provider}`,
          source: "webhook",
        },
      );
      if (!result.ok)
        throw fail(
          result.status === 403 || result.status === 401
            ? copy.permissions
            : result.status === 404
              ? copy.notFound
              : copy.failed,
          result.status,
        );
      return result.data as T;
    }
    if (verb === "projects" || (!arg && ["status", "logs", "restart", "redeploy"].includes(verb))) {
      const result = await call<{ data: ProjectSummary[] }>("GET", "/api/projects", {
        query: { page: 1, perPage: 20 },
      });
      const list = Array.isArray(result.data) ? result.data : [];
      const next = verb === "projects" ? "status" : verb;
      return list.length
        ? actions(
            [
              copy.projects,
              copy.chooseProject,
              ...(c.provider === "telegram"
                ? []
                : [
                    ...list.slice(0, 20).map((p) => `${label(p.name)} · ${identifier(p.id)}`),
                    `/openship ${next} <project-id>`,
                  ]),
              `${resolveDashboardPublicUrl()}/projects`,
            ].join("\n"),
            list
              .slice(0, 20)
              .filter((p) => identifier(p.id))
              .map((p) => ({ label: label(p.name), command: `${next} ${p.id}` })),
          )
        : reply(copy.noProjects);
    }
    if (verb === "confirm") {
      const pending = await readChallenge<Confirmation>(arg!, "action");
      const p = pending.value;
      if (
        pending.connectionId !== c.id ||
        p.sender !== senderKey(event) ||
        p.identityId !== identity.id ||
        p.clientId !== identity.clientId ||
        p.revision !== c.revision
      )
        throw fail(copy.sameSender, 403);
      const result = await call<{ data: ProjectSummary }>("GET", "/api/projects/:id", {
        id: p.projectId,
      });
      const project = result.data;
      if (!project || project.activeDeploymentId !== p.deploymentId) throw fail(copy.changed);
      await readChallenge(arg!, "action", true); // atomic, before any write; never replay a consumed confirmation
      await call("POST", `/api/deployments/:id/${p.verb}`, {
        id: p.deploymentId,
        ...(p.verb === "redeploy" ? { body: {} } : {}),
      });
      return reply(
        formatChat(p.verb === "redeploy" ? copy.redeployRequested : copy.requested, {
          action: copy.buttons[p.verb],
          name: label(project.name),
          url: projectUrl(p.projectId),
        }),
      );
    }
    const result = await call<{ data: ProjectSummary }>("GET", "/api/projects/:id", { id: arg });
    const project = result.data;
    if (!project?.id) throw fail(copy.notFound, 404);
    if (verb === "logs")
      return reply(
        formatChat(copy.logs, { name: label(project.name), url: `${projectUrl(project.id)}/logs` }),
      );
    if (verb === "status") {
      const deployments = await call<{ data: { status: string }[] }>(
        "GET",
        "/api/projects/:id/deployments",
        {
          id: project.id,
          query: { page: 1, perPage: 1 },
        },
      );
      const latest = (deployments.data ?? [])[0];
      return actions(
        `${label(project.name)}\n${formatChat(copy.latest, { status: latest ? label(latest.status) : copy.noDeployments })}\n${projectUrl(project.id)}${c.provider === "telegram" ? "" : `\n/openship logs ${project.id} · /openship restart ${project.id} · /openship redeploy ${project.id}`}`,
        (["logs", "restart", "redeploy"] as const).map((verb) => ({
          label: copy.buttons[verb],
          command: `${verb} ${project.id}`,
        })),
      );
    }
    if (!project.activeDeploymentId) throw fail(copy.noActive);
    if (verb !== "redeploy" && verb !== "restart") return reply(commandHelp(c.purpose, locale));
    const confirmation = await challenge(c.id, "action", {
      sender: senderKey(event),
      identityId: identity.id,
      clientId: identity.clientId,
      revision: c.revision,
      projectId: project.id,
      deploymentId: project.activeDeploymentId,
      verb,
    } satisfies Confirmation);
    return actions(
      formatChat(copy.confirm, {
        action: copy.buttons[verb],
        name: label(project.name),
        deployment: identifier(project.activeDeploymentId),
        effect: verb === "restart" ? copy.restartEffect : copy.redeployEffect,
        code: confirmation,
      }),
      [
        {
          label: `${copy.buttons.confirm} · ${copy.buttons[verb]}`,
          command: `confirm ${confirmation}`,
        },
      ],
    );
  }
  return {
    async handle(c: ChatAppConnection, incoming: HostEvent): Promise<ChatReply | null> {
      const locale = await chatLocale(c, incoming);
      const copy = chatCopy(locale);
      let event: HostEvent;
      try {
        event = await resolveChatAction(c, incoming);
      } catch {
        return chatReply(copy.expired);
      }
      await enabled(c.id, c.revision);
      if (event.integrationId !== c.nativeId)
        throw fail("This event belongs to another connector.", 403);
      const parsed = chatInput(event);
      const definition = CHAT_COMMANDS.find((command) => command.verb === parsed.verb)!;
      if (!chatCommandAvailable(definition, c.purpose)) return chatReply(copy.wrongRole);
      const isAssistant = definition.group === "assistant";
      const identity = await repos.chatApps.identity(c.id, event.workspaceId, event.userId);
      const id = fingerprint([c.id, event.id]);
      const requestFingerprint = fingerprint([
        c.revision,
        event.integrationId,
        senderKey(event),
        event.text,
        event.command,
        // A cached history/control response belongs to the same personal opt-in.
        ...(isAssistant ? [identity?.id, identity?.assistantRevision] : []),
      ]);
      const claimed = await repos.chatApps.claimCommand({
        id,
        connectionId: c.id,
        externalUser: event.userId,
        requestFingerprint,
        command: parsed.verb,
        identityId: identity?.id ?? null,
      });
      if (!claimed) {
        const previous = await repos.chatApps.command(id);
        if (previous?.requestFingerprint !== requestFingerprint) return chatReply(copy.changed);
        if (!["help", "start", "link", "verify", "unlink"].includes(previous.command)) {
          try {
            const current = await chatCredential(c, event);
            if (current.identity.id !== previous.identityId)
              throw fail("Chat account changed.", 403);
            if (isAssistant && assistant) await assistant.validate(c, event, previous);
          } catch {
            return chatReply(copy.permissions);
          }
        }
        if (isAssistant && previous.conversationId && assistant) {
          await repos.chatApps.updateDelivery(id, encrypt(JSON.stringify(event)));
          if (previous.state !== "done") {
            const reply = await assistant.result(c, event, previous);
            const response = reply === null ? null : chatReply(reply);
            if (response) await repos.chatApps.finishCommand(id, encrypt(JSON.stringify(response)));
            return response;
          }
        }
        return previous?.state === "done" && previous.response
          ? (JSON.parse(decrypt(previous.response)) as ChatReply)
          : chatReply(copy.interrupted);
      }
      let response: ChatReply | null;
      try {
        if (isAssistant) {
          const text = assistant ? await assistant.execute(c, event, id) : copy.assistantOff;
          response = text === null ? null : chatReply(text);
        } else response = await execute(c, event, locale);
      } catch (error) {
        response = chatReply(
          error instanceof AppError
            ? locale === "en" || Object.values(copy).includes(error.message)
              ? error.message
              : error.statusCode === 403
                ? copy.permissions
                : error.statusCode === 404
                  ? copy.notFound
                  : copy.failed
            : copy.failed,
        );
      }
      if (response !== null)
        await repos.chatApps.finishCommand(id, encrypt(JSON.stringify(response)));
      return response;
    },
  };
}
